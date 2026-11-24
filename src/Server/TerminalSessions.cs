using System.Collections.Concurrent;

namespace FileSharing;

internal sealed class TerminalSessions(Database db, TerminalStorage storage, AgentBroker broker, DeviceService devices,
    ReviewService reviews, IHostApplicationLifetime host)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> inputs = new();

    public async Task<TerminalView> Open(Review review, string deviceId, string? rootId, CancellationToken ct)
    {
        var device = await devices.Require(deviceId, ct);
        rootId ??= await db.One<string>("""
            SELECT r.Id FROM Roots r
            JOIN ObservedRoots o ON o.DeviceId=r.DeviceId AND o.RootKey=r.RootKey
            WHERE r.DeviceId=@deviceId AND r.Enabled=1 AND o.[Primary]=1
            """, new { deviceId }, ct) ?? throw Fault.Forbidden("root_access_denied");
        var root = await devices.Scope(device.Id, rootId, false, ct);
        var key = Secrets.New();
        var now = Clock.Now;
        var row = new TerminalRecord(Secrets.Id(), device.Id, root.Id, review.Initiator, Secrets.Hash(key), root.ConnectionId,
            "starting", now, now, null, 0, 0, null, 0, null, null, 0, null);
        await storage.Create(row, ct);
        try
        {
            await broker.Invoke(row.DeviceId, "terminal.create", new { root = root.RootKey, key }, host.ApplicationStopping,
                row.Id, TimeSpan.FromSeconds(9), row.ConnectionId);
        }
        catch (Fault error) when (error.Code is "device_timeout" or "agent_connection_ended" or "device_unavailable"
            or "agent_connection_access_required")
        {
            // The Mac may already own the session. Its next synchronization establishes the actual state.
            return View(await Read(row.Id, ct));
        }
        catch (Fault error)
        {
            await storage.CloseFailedStart(row.Id, error.Code, CancellationToken.None);
            throw;
        }

        for (var i = 0; i < 40; i++)
        {
            row = await Read(row.Id, ct);
            if (row.State != "starting")
                break;
            await Task.Delay(100, ct);
        }
        return View(row);
    }

    public async Task<TerminalList> List(Review review, string deviceId, string? cursor, int? limit, CancellationToken ct)
    {
        var count = Page<TerminalView>.Size(limit);
        var rows = await storage.List(review.Initiator, Secrets.Identifier(deviceId), Page<TerminalView>.After(cursor), count + 1, ct);
        var active = cursor is null ? await storage.Active(review.Initiator, deviceId, ct) : null;
        var ids = rows.Select(row => row.Id).Concat(active is null ? [] : [active.Id]).Distinct().ToArray();
        IReadOnlyDictionary<string, string> titles = ids.Length == 0 ? new Dictionary<string, string>() : await storage.Titles(ids, ct);
        TerminalView Listed(TerminalRecord row) => View(row) with { FirstCommand = titles.GetValueOrDefault(row.Id) };
        var page = Page<TerminalView>.From(rows.Select(Listed).ToArray(), count, item => item.Id);
        return new(page.Items, page.NextCursor, active is null ? null : Listed(active));
    }

    public async Task<TerminalRecord> Find(Review review, string deviceId, string id, CancellationToken ct)
    {
        var row = await Read(Secrets.Identifier(id), ct);
        if (row.Owner != review.Initiator || row.DeviceId != Secrets.Identifier(deviceId))
            throw Fault.Missing("terminal_not_found");
        return row;
    }

    public TerminalView View(TerminalRecord row)
    {
        var connection = broker.Presence(row.DeviceId);
        var connected = !row.Closed && row.AgentCursor > 0 && connection.Online && connection.ConnectionId == row.ConnectionId;
        return new(row.Id, row.DeviceId, row.RootId, row.ConnectionId, row.Interactive != 0, row.State, connected,
            connected && connection.AccessGranted && row.State == "open", row.CommandId, row.Started != 0,
            Clock.At(row.Created), Clock.At(row.Updated), row.Finished is { } finished ? Clock.At(finished) : null, row.Code);
    }

    public async Task Transcript(TerminalRecord row, Stream stream, CancellationToken ct)
    {
        await using var output = new StreamWriter(stream, leaveOpen: true);
        for (long after = 0; after < row.Cursor;)
        {
            var frames = await storage.Frames(row.Id, after, row.Cursor, ct);
            if (frames.Count == 0)
                break;
            foreach (var frame in frames)
                await output.WriteLineAsync(frame.AsMemory(), ct);
            after += frames.Count;
        }
    }

    public async Task<TerminalPage> Output(TerminalRecord row, long after, CancellationToken ct)
    {
        if (after < 0 || after > row.Cursor)
            throw Fault.Bad("invalid_output_cursor");
        var stored = await storage.Frames(row.Id, after, row.Cursor, ct);
        var items = stored.Select(item => Wire.Model<TerminalFrame>(Wire.Parse(item))).ToArray();
        var cursor = items.LastOrDefault()?.Index ?? after;
        var more = cursor < row.Cursor;
        return new(items, cursor, row.Closed && !more, false, more, View(row));
    }

    public async Task<string> Execute(TerminalRecord row, string? line, CancellationToken ct)
    {
        var command = Parse(line);
        await Authorize(row, ct);
        var id = Secrets.Id();
        await storage.Begin(row.Id, id, line!.Trim(), command with { CommandId = id }, ct);
        return id;
    }

    public async Task Interrupt(TerminalRecord row, CancellationToken ct)
    {
        await Authorize(row, ct);
        if (row is { Started: > 0, CommandId: { } id })
            await broker.Invoke(row.DeviceId, "terminal.input", new { kind = "interrupt", sessionId = row.Id, commandId = id },
                ct, connectionId: row.ConnectionId);
    }

    public Task Terminate(TerminalRecord row, CancellationToken ct) =>
        storage.Terminate(row.Id, "terminal_terminated", ct);

    public Task Delete(TerminalRecord row, CancellationToken ct) => storage.Delete(row.Id, ct);

    public async Task StopDevice(string id, CancellationToken ct)
    {
        var active = await db.List<string>("SELECT Id FROM TerminalSessions WHERE DeviceId=@id AND State<>'terminated'", new { id }, ct);
        foreach (var session in active)
            await storage.Terminate(session, "terminal_access_revoked", ct);
    }

    public async Task Control(Review review, string deviceId, string sessionId, TerminalControl input, CancellationToken ct)
    {
        var id = Secrets.Identifier(input.Id);
        var target = ValidateControl(input);
        var inputGate = inputs.GetOrAdd(deviceId, _ => new SemaphoreSlim(1));
        await inputGate.WaitAsync(ct);
        try
        {
            if (await reviews.ActiveById(review.Id, ct) is null)
                throw Fault.Unauthorized();
            var row = await Find(review, deviceId, sessionId, ct);
            await Authorize(row, ct);
            if (await storage.HasInput(row.Id, id, ct))
                return;
            if (row.Interactive == 0)
                throw Fault.Conflict("terminal_interactive_unavailable");
            if (target is not null && (row.CommandId != target || row.Started == 0))
                throw Fault.Conflict("terminal_command_ended");
            await broker.Invoke(row.DeviceId, "terminal.control", new
            {
                sessionId = row.Id, input.Kind, input.CommandId, input.Data, input.Rows, input.Columns
            }, host.ApplicationStopping, id, TimeSpan.FromSeconds(6), row.ConnectionId);
            await storage.RecordInput(row.Id, id, CancellationToken.None);
        }
        finally
        {
            inputGate.Release();
        }
    }

    public async Task<TerminalSyncResult> Synchronize(string id, string? key, TerminalSync body, CancellationToken ct)
    {
        if (key is not { Length: 43 } || body.Frames is not { Count: <= 32 } frames)
            throw Fault.Bad("invalid_terminal_sync");
        Secrets.Identifier(id);
        try
        {
            var existing = await Read(id, ct);
            var presence = broker.Presence(existing.DeviceId);
            var active = presence.Online && presence.ConnectionId == body.ConnectionId ? presence.ConnectionId : null;
            var row = await storage.Synchronize(id, key, active, frames, ct);
            var terminate = row.Closed || row.State == "terminating";
            TerminalDispatch? dispatch = null;
            if (!terminate && active is not null && broker.AccessGeneration(row.DeviceId, active) is not null &&
                row.Pending is { } pending)
                dispatch = Wire.Model<TerminalDispatch>(Wire.Parse(pending));
            return new(row.AgentCursor, terminate, dispatch);
        }
        catch (Fault error) when (error.Code == "terminal_not_found")
        {
            if (await storage.WasDeleted(id, key, ct))
                return new(0, true, null, Deleted: true);
            throw;
        }
    }

    private async Task<TerminalRecord> Read(string id, CancellationToken ct) =>
        await storage.Find(id, ct) ?? throw Fault.Missing("terminal_not_found");

    private async Task Authorize(TerminalRecord row, CancellationToken ct)
    {
        if (row.State != "open")
            throw Fault.Conflict("terminal_closed");
        if (!View(row).Connected)
            throw Fault.Conflict("terminal_detached");
        await devices.Scope(row.DeviceId, row.RootId, false, ct, row.ConnectionId);
    }

    private static string? ValidateControl(TerminalControl input)
    {
        if (input is { Kind: "resize", CommandId: null, Data: null, Rows: >= 2 and <= 160, Columns: >= 2 and <= 300 })
            return null;
        if (input is { Kind: "keys", Rows: null, Columns: null, Data.Length: >= 4 and <= 5464 })
        {
            Span<byte> bytes = stackalloc byte[4096];
            if (Convert.TryFromBase64String(input.Data, bytes, out var count) && count > 0)
                return Secrets.Identifier(input.CommandId);
        }
        throw Fault.Bad("invalid_terminal_input");
    }

    private static TerminalDispatch Parse(string? line)
    {
        if (string.IsNullOrWhiteSpace(line) || line.Length > 8192)
            throw Fault.Bad("invalid_diagnostic_command");
        line = line.Trim();
        if (line == "pwd")
            return new("pwd");
        var space = line.IndexOfAny([' ', '\t']);
        if (line == "cd" || space == 2 && line.StartsWith("cd", StringComparison.Ordinal))
        {
            var path = space < 0 ? "~" : line[(space + 1)..].Trim();
            if (path is [ '\'' or '"', .. ] && path.Length >= 2 && path[^1] == path[0])
                path = path[1..^1];
            return new("cd", Path: path);
        }
        var command = DataEndpoints.ParseDiagnostic(line);
        return new("run", Executable: command.Executable, Arguments: command.Arguments);
    }
}
