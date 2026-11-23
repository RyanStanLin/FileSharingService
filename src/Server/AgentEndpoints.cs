using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;

namespace FileSharing;

internal sealed record LocalRoot(string RootKey, string Label, bool Writable, bool Primary)
{
    public LocalRoot() : this("", "", false, false) { }
}
internal sealed record AgentFrames(IReadOnlyList<AgentFrame> Frames);
internal sealed record AgentPulse(double LatencyMs);
internal sealed record AgentPolicy(string DeviceId, long Revision, bool Inherited, Sampling Settings, bool AccessGranted);
internal sealed record AgentReady(string Type, string DeviceId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? PreviouslyAllowedFolders);
internal sealed record AgentConnected(string DeviceId, string? Channel,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? PreviouslyAllowedFolders);

internal sealed class AgentIngest(Database db, AgentBroker broker, WatchRegistry watches, WindowFeed windows)
{
    public static readonly string[] SnapshotTopics =
        ["identity", "cpu", "memory", "disk", "battery", "power", "system", "displays", "locale", "network", "agent",
         "apps-running", "apps-installed", "storage", "permissions", "roots", "lid"];

    public async Task<string[]?> PreviouslyAllowedFolders(string device, CancellationToken ct)
    {
        var payload = await db.One<string>("SELECT Payload FROM Snapshots WHERE DeviceId=@device AND Topic='permissions'",
            new { device }, ct);
        if (payload is null || Wire.Parse(payload) is not { ValueKind: JsonValueKind.Object } permissions)
            return null;

        string[] folders = ["downloads", "documents", "desktop"];
        var approved = folders.Where(folder =>
            permissions.TryGetProperty(folder, out var check) && check.ValueKind == JsonValueKind.Object &&
            check.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.String && state.GetString() == "allowed" &&
            check.TryGetProperty("phase", out var phase) && phase.ValueKind == JsonValueKind.String && phase.GetString() == "completed"
        ).ToArray();
        return approved.Length == 0 ? null : approved;
    }

    public async Task Receive(AgentBroker.Link link, AgentFrame frame, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var device = link.Device;
        if (frame.Type == "result")
        {
            broker.Complete(link, frame);
            return;
        }
        if (frame.Type == "pong")
            return;
        if (frame.Type == "progress")
        {
            await broker.Progress(link, frame, ct);
            return;
        }
        if (frame is not { Type: "event", Id: { } id, Topic: { } topic, Payload: { } payload } ||
            !Guid.TryParseExact(id, "D", out var frameId))
            throw Fault.Bad("invalid_event");

        if (topic == "files.changed")
        {
            if (broker.HasAccess(link))
                await watches.Ingest(device, link.Id, payload, ct);
            return;
        }
        if (topic == WindowFeed.Topic)
        {
            windows.Ingest(link, id, frame.Snapshot, payload);
            return;
        }

        var snapshot = frame.Snapshot == true && SnapshotTopics.Contains(topic);
        if (!snapshot && topic is not ("applications.changed" or "storage.changed" or "system.changed" or "telemetry.gap"
                                      or "clipboard.changed" or "lid.changed"))
            throw Fault.Bad("invalid_topic");
        if (payload.GetRawText().Length > 1_250_000)
            throw new Fault(413, "event_too_large");

        if (topic == "clipboard.changed")
        {
            // Persist a freshly typed timestamp, never an arbitrary pasteboard payload.
            if (frame.Snapshot == true || payload.ValueKind != JsonValueKind.Object ||
                payload.EnumerateObject().Count() != 1 || !payload.TryGetProperty("occurredAt", out var timestamp) ||
                timestamp.ValueKind != JsonValueKind.String || !timestamp.TryGetDateTimeOffset(out var occurredAt))
                throw Fault.Bad("invalid_clipboard_event");
            payload = Wire.Element(new { occurredAt = occurredAt.ToUniversalTime() });
        }

        LocalRoot[]? roots = null;
        if (topic == "roots")
        {
            roots = Wire.Model<LocalRoot[]>(payload);
            if (roots.Length > 24 || roots.Count(root => root.Primary) > 1 || roots.Select(x => x.RootKey).Distinct().Count() != roots.Length)
                throw Fault.Bad("invalid_roots");
            foreach (var root in roots)
            {
                Secrets.Identifier(root.RootKey);
                Secrets.Text(root.Label);
            }
        }
        id = frameId.ToString("D");
        await db.Write(async (connection, tx) =>
        {
            var now = Clock.Now;
            var accepted = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO AgentReceipts(DeviceId,FrameId,At)
                SELECT @device,@id,@now WHERE EXISTS(SELECT 1 FROM Devices WHERE Id=@device AND Revoked IS NULL)
                """, new { device, id, now }, tx, cancellationToken: ct));
            if (accepted == 0)
                return false;
            var json = new { device, topic, now, Payload = payload.GetRawText() };
            if (snapshot)
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO Snapshots(DeviceId,Topic,At,Payload) VALUES(@device,@topic,@now,@Payload)
                    ON CONFLICT(DeviceId,Topic) DO UPDATE SET At=excluded.At,Payload=excluded.Payload
                    """, json, tx, cancellationToken: ct));
            var source = await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@device,@topic,@now,@Payload) RETURNING Sequence
                """, json, tx, cancellationToken: ct));
            if (broker.CanNotify(link))
            {
                var signals = await NotificationSignals.FromFrame(connection, tx, device, topic, snapshot, payload, now, ct);
                await NotificationMatcher.Match(connection, tx, device, source, now, signals, ct);
            }
            if (roots is not null)
            {
                await connection.ExecuteAsync(new CommandDefinition("DELETE FROM ObservedRoots WHERE DeviceId=@device",
                    new { device }, tx, cancellationToken: ct));
                foreach (var root in roots)
                    await connection.ExecuteAsync(new CommandDefinition("INSERT INTO ObservedRoots VALUES(@device,@RootKey,@Label,@Writable,@Primary)",
                        new { device, root.RootKey, root.Label, root.Writable, root.Primary }, tx, cancellationToken: ct));
                if (roots.SingleOrDefault(root => root.Primary) is { } home)
                {
                    var added = await connection.ExecuteAsync(new CommandDefinition("""
                        INSERT INTO Roots(Id,DeviceId,RootKey,Label,Writable,Enabled)
                        SELECT @id,@device,@RootKey,@Label,@Writable,1
                        WHERE EXISTS(SELECT 1 FROM Devices WHERE Id=@device AND AddedDefaultRoot=0)
                        """, new { id = Secrets.Id(), device, home.RootKey, home.Label, home.Writable }, tx, cancellationToken: ct));
                    if (added == 1)
                        await connection.ExecuteAsync(new CommandDefinition("""
                            UPDATE Devices SET AddedDefaultRoot=1 WHERE Id=@device;
                            INSERT INTO Audit(At,DeviceId,Action,Detail) VALUES(@now,@device,'root.default_added',@detail);
                            """, new { device, now, detail = Wire.Encode(new { home.RootKey, home.Writable }) }, tx, cancellationToken: ct));
                }
            }
            return true;
        });
    }
}

internal static class AgentEndpoints
{
    public static void Map(WebApplication app)
    {
        var group = app.MapGroup("/agent/v1").ExcludeFromDescription();
        group.MapPost("/connect", async (AgentHello body, HttpContext context, AgentBroker broker, AgentIngest ingest, CancellationToken ct) =>
        {
            var link = await broker.Open(body, "https", context, ct);
            try
            {
                var previouslyAllowedFolders = await ingest.PreviouslyAllowedFolders(link.Device, ct);
                return TypedResults.Ok(new AgentConnected(link.Device, link.Channel, previouslyAllowedFolders));
            }
            catch
            {
                await broker.Close(link, CancellationToken.None);
                throw;
            }
        }).RequireRateLimiting("agent-connect");
        group.MapDelete("/connection", async (HttpContext context, AgentBroker broker, CancellationToken ct) =>
        {
            await broker.Close(broker.OpenChannel(context), ct);
            return TypedResults.NoContent();
        });
        group.MapGet("/commands", async (HttpContext ctx, AgentBroker broker, CancellationToken ct) =>
        {
            var link = broker.OpenChannel(ctx);
            await broker.Seen(link, ct);
            return TypedResults.Ok(await broker.Commands(link, TimeSpan.FromSeconds(20), ct));
        });
        group.MapPost("/frames", async (AgentFrames body, HttpContext ctx, AgentIngest ingest, AgentBroker broker, CancellationToken ct) =>
        {
            var link = broker.OpenChannel(ctx);
            if (body.Frames is not { Count: <= 8 })
                throw Fault.Bad("frame_limit");
            using var request = CancellationTokenSource.CreateLinkedTokenSource(ct, link.Lifetime);
            await broker.Seen(link, request.Token);
            foreach (var frame in body.Frames)
                await ingest.Receive(link, frame, request.Token);
            return TypedResults.NoContent();
        });
        group.MapPost("/pulse", async (AgentPulse body, HttpContext ctx, AgentBroker broker, CancellationToken ct) =>
        {
            var link = broker.OpenChannel(ctx);
            if (!double.IsFinite(body.LatencyMs) || body.LatencyMs < 0 || body.LatencyMs > 60_000)
                throw Fault.Bad("invalid_latency");
            await broker.Seen(link, ct, body.LatencyMs);
            return TypedResults.NoContent();
        });
        group.MapGet("/policy", async (HttpContext ctx, AgentBroker broker, DeviceService devices, CancellationToken ct) =>
            TypedResults.Ok(await Policy(broker.OpenChannel(ctx), broker, devices, ct)));
        group.MapGet("/ws", Socket).RequireRateLimiting("agent-connect");
    }

    private static async Task<AgentPolicy> Policy(AgentBroker.Link link, AgentBroker broker, DeviceService devices, CancellationToken ct)
    {
        var policy = await devices.Policy(link.Device, ct);
        var authorized = broker.HasAccess(link);
        return new(policy.DeviceId, policy.Revision, policy.Inherited,
            authorized ? policy.Settings : policy.Settings with { KeepAwake = false }, authorized);
    }

    private static async Task Socket(HttpContext context, AgentBroker broker, AgentIngest ingest, DeviceService devices, CancellationToken ct)
    {
        if (!context.WebSockets.IsWebSocketRequest)
            throw Fault.Bad("websocket_required");

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var handshake = CancellationTokenSource.CreateLinkedTokenSource(ct);
        handshake.CancelAfter(TimeSpan.FromSeconds(8));
        AgentBroker.Link link;
        try
        {
            var hello = await SocketWire.Read<AgentHello>(socket, 4096, handshake.Token);
            if (hello?.Type != "hello")
                throw Fault.Bad("agent_hello_required");
            link = await broker.Open(hello, "wss", context, handshake.Token);
        }
        catch (Fault fault)
        {
            try
            {
                await SocketWire.Send(socket, new { type = "error", code = fault.Code }, handshake.Token);
                await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "", handshake.Token);
            }
            catch (Exception error) when (error is OperationCanceledException or WebSocketException)
            {
                socket.Abort();
            }
            return;
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or System.Text.Json.JsonException)
        {
            socket.Abort();
            return;
        }

        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct, link.Lifetime);
        var life = stop.Token;
        var pings = new System.Collections.Concurrent.ConcurrentDictionary<string, long>();
        var acknowledgements = System.Threading.Channels.Channel.CreateBounded<string>(128);
        try
        {
            var previouslyAllowedFolders = await ingest.PreviouslyAllowedFolders(link.Device, life);
            await SocketWire.Send(socket, new AgentReady("ready", link.Device, previouslyAllowedFolders), life);
            var input = Receive();
            var output = Send();
            await Task.WhenAny(input, output);
            await stop.CancelAsync();
            await Task.WhenAll(input, output);
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or Fault or System.Text.Json.JsonException)
        {
            socket.Abort();
        }
        finally
        {
            await broker.Close(link, CancellationToken.None);
        }

        async Task Receive()
        {
            while (await SocketWire.Read<AgentFrame>(socket, 1_500_000, life) is { } frame)
            {
                double? latency = frame.Type == "pong" && frame.Id is { } id && pings.TryRemove(id, out var ticks)
                    ? Stopwatch.GetElapsedTime(ticks).TotalMilliseconds : null;
                await broker.Seen(link, life, latency);
                await ingest.Receive(link, frame, life);
                if (frame is { Type: "event", Id: { } eventId })
                    await acknowledgements.Writer.WriteAsync(eventId, life);
            }
        }

        async Task Send()
        {
            var lastPolicy = 0L;
            var lastPing = 0L;
            while (!life.IsCancellationRequested)
            {
                var now = Stopwatch.GetTimestamp();
                if (lastPing == 0 || Stopwatch.GetElapsedTime(lastPing, now).TotalSeconds >= 5)
                {
                    lastPing = now;
                    pings.Clear();
                    var ping = Secrets.Id();
                    pings[ping] = Stopwatch.GetTimestamp();
                    await SocketWire.Send(socket, new { type = "ping", id = ping }, life);
                }
                if (lastPolicy == 0 || Stopwatch.GetElapsedTime(lastPolicy, now).TotalSeconds >= 5)
                {
                    lastPolicy = now;
                    var policy = await Policy(link, broker, devices, life);
                    await SocketWire.Send(socket, new { type = "policy", payload = policy }, life);
                }
                while (acknowledgements.Reader.TryRead(out var acknowledged))
                    await SocketWire.Send(socket, new { type = "ack", id = acknowledged }, life);
                foreach (var command in await broker.Commands(link, TimeSpan.FromMilliseconds(250), life))
                    await SocketWire.Send(socket, command, life);
            }
        }
    }
}
