using System.Diagnostics;
using System.Net.WebSockets;
using Dapper;

namespace FileSharing;

internal sealed record LocalRoot(string RootKey, string Label, bool Writable, bool Primary)
{
    public LocalRoot() : this("", "", false, false) { }
}
internal sealed record AgentFrames(IReadOnlyList<AgentFrame> Frames);
internal sealed record AgentPulse(double LatencyMs);

internal sealed class AgentIngest(Database db, AgentBroker broker, WatchRegistry watches)
{
    public static readonly string[] SnapshotTopics =
        ["identity", "cpu", "memory", "disk", "battery", "power", "system", "displays", "locale", "network", "agent",
         "apps-running", "apps-installed", "storage", "permissions", "roots"];

    public async Task Receive(string device, AgentFrame frame, CancellationToken ct)
    {
        if (frame.Type == "result")
        {
            broker.Complete(device, frame);
            return;
        }
        if (frame.Type == "pong")
            return;
        if (frame is not { Type: "event", Id: { } id, Topic: { } topic, Payload: { } payload } ||
            !Guid.TryParseExact(id, "D", out _))
            throw Fault.Bad("invalid_event");

        if (topic == "files.changed")
        {
            await watches.Ingest(device, payload, ct);
            return;
        }

        var snapshot = frame.Snapshot == true && SnapshotTopics.Contains(topic);
        if (!snapshot && topic is not ("applications.changed" or "storage.changed" or "system.changed" or "telemetry.gap"))
            throw Fault.Bad("invalid_topic");
        if (payload.GetRawText().Length > 1_250_000)
            throw new Fault(413, "event_too_large");

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
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@device,@topic,@now,@Payload)
                """, json, tx, cancellationToken: ct));
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
        group.MapPost("/activate", async (ActivationRequest body, AgentIdentity identity, CancellationToken ct) =>
            TypedResults.Ok(await identity.Activate(body, ct))).RequireRateLimiting("agent-auth");
        group.MapPost("/challenge", async (DeviceChallengeRequest body, AgentIdentity identity, CancellationToken ct) =>
            TypedResults.Ok(await identity.Challenge(body, ct))).RequireRateLimiting("agent-auth");
        group.MapPost("/session", async (AgentSessionRequest body, AgentIdentity identity, CancellationToken ct) =>
            TypedResults.Ok(await identity.Authorize(body, ct))).RequireRateLimiting("agent-auth");
        group.MapGet("/commands", async (HttpContext ctx, AgentIdentity identity, AgentBroker broker, CancellationToken ct) =>
        {
            var device = await identity.Require(ctx, ct);
            await broker.Seen(device, "https", ct);
            return TypedResults.Ok(await broker.Commands(device, TimeSpan.FromSeconds(20), ct));
        });
        group.MapPost("/frames", async (AgentFrames body, HttpContext ctx, AgentIdentity identity, AgentIngest ingest, AgentBroker broker, CancellationToken ct) =>
        {
            var device = await identity.Require(ctx, ct);
            if (body.Frames is not { Count: <= 8 })
                throw Fault.Bad("frame_limit");
            await broker.Seen(device, "https", ct);
            foreach (var frame in body.Frames)
                await ingest.Receive(device, frame, ct);
            return TypedResults.NoContent();
        });
        group.MapPost("/pulse", async (AgentPulse body, HttpContext ctx, AgentIdentity identity, AgentBroker broker, CancellationToken ct) =>
        {
            var device = await identity.Require(ctx, ct);
            if (!double.IsFinite(body.LatencyMs) || body.LatencyMs < 0 || body.LatencyMs > 60_000)
                throw Fault.Bad("invalid_latency");
            await broker.Seen(device, "https", ct, body.LatencyMs);
            return TypedResults.NoContent();
        });
        group.MapGet("/policy", async (HttpContext ctx, AgentIdentity identity, DeviceService devices, CancellationToken ct) =>
            TypedResults.Ok(await devices.Policy(await identity.Require(ctx, ct), ct)));
        group.MapGet("/ws", Socket);
    }

    private static async Task Socket(HttpContext context, AgentIdentity identity, AgentBroker broker, AgentIngest ingest, CancellationToken ct)
    {
        var device = await identity.Require(context, ct);
        if (!context.WebSockets.IsWebSocketRequest)
            throw Fault.Bad("websocket_required");
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var pings = new System.Collections.Concurrent.ConcurrentDictionary<string, long>();
        var life = stop.Token;
        var acknowledgements = System.Threading.Channels.Channel.CreateBounded<string>(128);
        var input = Receive();
        var output = Send();
        await Task.WhenAny(input, output);
        await stop.CancelAsync();
        try
        {
            await Task.WhenAll(input, output);
        }
        catch (Exception e) when (e is OperationCanceledException or WebSocketException or Fault or System.Text.Json.JsonException)
        {
            socket.Abort();
        }

        async Task Receive()
        {
            while (await SocketWire.Read<AgentFrame>(socket, 1_500_000, life) is { } frame)
            {
                if (await identity.Verify(context, life) != device)
                    return;
                double? latency = frame.Type == "pong" && frame.Id is { } id && pings.TryRemove(id, out var ticks) ?
                    Stopwatch.GetElapsedTime(ticks).TotalMilliseconds : null;
                await broker.Seen(device, "wss", life, latency);
                await ingest.Receive(device, frame, life);
                if (frame is { Type: "event", Id: { } eventId })
                    await acknowledgements.Writer.WriteAsync(eventId, life);
            }
        }

        async Task Send()
        {
            await broker.Seen(device, "wss", life);
            while (!life.IsCancellationRequested)
            {
                if (await identity.Verify(context, life) != device)
                    return;
                if (!pings.Values.Any(t => Stopwatch.GetElapsedTime(t) < TimeSpan.FromSeconds(10)))
                {
                    pings.Clear();
                    var ping = Secrets.Id();
                    pings[ping] = Stopwatch.GetTimestamp();
                    await SocketWire.Send(socket, new { type = "ping", id = ping }, life);
                }
                while (acknowledgements.Reader.TryRead(out var acknowledged))
                    await SocketWire.Send(socket, new { type = "ack", id = acknowledged }, life);
                foreach (var command in await broker.Commands(device, TimeSpan.FromMilliseconds(250), life))
                    await SocketWire.Send(socket, command, life);
            }
        }
    }
}
