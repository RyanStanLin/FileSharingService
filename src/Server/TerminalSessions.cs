using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

namespace FileSharing;

internal sealed class TerminalSessions(Database db, AgentBroker broker, DeviceService devices, ReviewService reviews,
    IHostApplicationLifetime host, ILogger<TerminalSessions> logger)
{
    private readonly ConcurrentDictionary<string, TerminalSession> sessions = new();

    public async Task<TerminalView> Open(Review review, string deviceId, string? rootId, CancellationToken ct)
    {
        var device = await devices.Require(deviceId, ct);
        rootId ??= await db.One<string>("""
            SELECT r.Id FROM Roots r
            JOIN ObservedRoots o ON o.DeviceId=r.DeviceId AND o.RootKey=r.RootKey
            WHERE r.DeviceId=@deviceId AND r.Enabled=1 AND o.[Primary]=1
            """, new { deviceId }, ct) ?? throw Fault.Forbidden("root_access_denied");
        var root = await devices.Scope(device.Id, rootId, false, ct);
        var session = new TerminalSession(new(Secrets.Id(), device.Id, root.Id, root.ConnectionId!), root.RootKey, review.Id);
        var added = sessions.TryAdd(device.Id, session);
        if (!added && sessions.TryGetValue(device.Id, out var prior) && prior.Closed.IsCompleted)
            added = sessions.TryUpdate(device.Id, session, prior);
        if (!added)
            throw Fault.Conflict("terminal_busy");

        _ = Relay(session);
        try
        {
            var error = await session.Ready.WaitAsync(TimeSpan.FromSeconds(20), ct);
            if (error is not null)
                throw Fault.Unavailable(error);
            return session.View;
        }
        catch (TimeoutException)
        {
            Finish(session, "device_timeout");
            throw Fault.Unavailable("device_timeout");
        }
        catch
        {
            Finish(session, "terminal_closed");
            throw;
        }
    }

    public TerminalSession Find(Review review, string deviceId, string sessionId)
    {
        Secrets.Identifier(sessionId);
        return sessions.TryGetValue(Secrets.Identifier(deviceId), out var session) &&
            session.View.Id == sessionId && session.ReviewId == review.Id
            ? session : throw Fault.Missing("terminal_not_found");
    }

    public async Task Authorize(TerminalSession session, CancellationToken ct)
    {
        if (await reviews.ActiveById(session.ReviewId, ct) is null)
            throw Fault.Unauthorized();
        var view = session.View;
        await devices.Scope(view.DeviceId, view.RootId, false, ct, view.ConnectionId);
    }

    public async Task<string> Execute(TerminalSession session, string? line, CancellationToken ct)
    {
        var input = Parse(line);
        await Authorize(session, ct);
        var id = Secrets.Id();
        session.Begin(id, line!.Trim());
        _ = Forward(session, input with { SessionId = session.View.Id, CommandId = id }, id);
        return id;
    }

    public async Task Interrupt(TerminalSession session, CancellationToken ct)
    {
        await Authorize(session, ct);
        if (session.InterruptCommand() is { } id)
            await Forward(session, new("interrupt", session.View.Id, id), Secrets.Id());
    }

    public void Close(TerminalSession session) => Finish(session, "terminal_closed");

    private async Task Relay(TerminalSession session)
    {
        var view = session.View;
        var stop = host.ApplicationStopping;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop);
        var run = broker.Invoke(view.DeviceId, "terminal.open", new { root = session.RootKey }, lifetime.Token, view.Id,
            TimeSpan.FromHours(8), view.ConnectionId, (frame, _) => Progress(session, frame));
        try
        {
            while (true)
            {
                var tick = Task.Delay(TimeSpan.FromSeconds(3), lifetime.Token);
                if (await Task.WhenAny(run, session.Closed, tick) != tick)
                    break;
                stop.ThrowIfCancellationRequested();
                if (session.Idle())
                    throw Fault.Conflict("terminal_idle");
                await Authorize(session, lifetime.Token);
            }
            if (!run.IsCompleted)
                CancelAgent(session);
            await run;
            session.End("terminal_closed");
        }
        catch (Fault error)
        {
            Finish(session, error.Code);
        }
        catch (OperationCanceledException)
        {
            Finish(session, "terminal_closed");
        }
        catch (Exception error)
        {
            logger.LogError(error, "Terminal {SessionId} ended unexpectedly", view.Id);
            Finish(session, "terminal_unavailable");
        }
        finally
        {
            await lifetime.CancelAsync();
            try { await run; }
            catch { /* The session is already closed and the failure has been handled. */ }
        }

        try { await Task.Delay(TimeSpan.FromSeconds(30), stop); }
        catch (OperationCanceledException) { }
        sessions.TryRemove(new KeyValuePair<string, TerminalSession>(view.DeviceId, session));
    }

    private static Task Progress(TerminalSession session, JsonElement frame)
    {
        try { session.Accept(frame); }
        catch (Fault error) { session.End(error.Code); }
        return Task.CompletedTask;
    }

    private async Task Forward(TerminalSession session, TerminalInput input, string id)
    {
        try
        {
            await broker.Invoke(session.View.DeviceId, "terminal.input", input, host.ApplicationStopping, id,
                TimeSpan.FromSeconds(15), session.View.ConnectionId);
        }
        catch (Fault error)
        {
            Finish(session, error.Code);
        }
        catch (OperationCanceledException)
        {
            Finish(session, "terminal_closed");
        }
        catch (Exception error)
        {
            logger.LogError(error, "Terminal {SessionId} could not accept input", session.View.Id);
            Finish(session, "terminal_unavailable");
        }
    }

    private void Finish(TerminalSession session, string code)
    {
        CancelAgent(session);
        session.End(code);
    }

    private void CancelAgent(TerminalSession session) =>
        broker.CancelCommand(session.View.DeviceId, session.View.ConnectionId, session.View.Id);

    private static TerminalInput Parse(string? line)
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

    private sealed record TerminalInput(string Kind, string? SessionId = null, string? CommandId = null,
        string? Executable = null, string[]? Arguments = null, string? Path = null);
}
