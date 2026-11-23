using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using Dapper;

namespace FileSharing;

internal sealed record AgentCommand(string Type, string Id, string Kind, JsonElement Payload);
internal sealed record AgentFrame(string Type, string? Id, string? Topic, string? Code, JsonElement? Payload, bool? Ok, bool? Snapshot);
internal sealed record AgentPresence(bool Online, string? Protocol, DateTimeOffset? ConnectedAt, DateTimeOffset? LastCommunicationAt,
    double? LatencyMs, long? ConnectionSeconds, string? ConnectionId, bool AccessGranted, string? PeerAddress);

internal sealed class AgentBroker(Database db, AgentRegistration registration, NotificationDeviceTrust trust,
    IHostApplicationLifetime lifetime, ILogger<AgentBroker> logger)
{
    internal const string ChannelHeader = "X-FileSharing-Channel";
    private static readonly TimeSpan PresenceWindow = TimeSpan.FromSeconds(45);

    internal sealed class Pending(AgentCommand command, Func<JsonElement, CancellationToken, Task>? progress)
    {
        public AgentCommand Command { get; } = command;
        public Func<JsonElement, CancellationToken, Task>? Progress { get; } = progress;
        public TaskCompletionSource<AgentFrame> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long LeaseUntil { get; set; }
    }

    private enum PresenceChange { None, Open, Close }

    internal sealed class Link(string device, string protocol, string? peerAddress, string? notificationProof)
    {
        private readonly CancellationTokenSource stop = new();

        public string Device { get; } = device;
        public string Id { get; } = Secrets.Id();
        public string Protocol { get; } = protocol;
        public string? PeerAddress { get; } = peerAddress;
        public string? NotificationProof { get; } = notificationProof;
        public bool NotificationTrusted { get; set; }
        public SemaphoreSlim Lifecycle { get; } = new(1, 1);
        public string? Channel { get; } = protocol == "https" ? Secrets.New() : null;
        public CancellationToken Lifetime => stop.Token;
        public Dictionary<string, Pending> Pending { get; } = [];
        public Queue<AgentCommand> Cancellations { get; } = [];
        public WindowChannel Windows { get; } = new();
        public SemaphoreSlim Signal { get; } = new(0, 1);
        public long Seen { get; set; } = Clock.Now;
        public long LastSignal { get; set; } = Stopwatch.GetTimestamp();
        public long Connected { get; } = Clock.Now;
        public long ConnectedTick { get; } = Stopwatch.GetTimestamp();
        public double? Latency { get; set; }
        public long QualityReported { get; set; }
        public bool Closed { get; set; }
        public bool AccessGranted { get; set; }
        public long AccessGeneration { get; set; }

        public Task Cancel() => stop.CancelAsync();
    }

    private readonly ConcurrentDictionary<string, Link> links = new();
    private readonly ConcurrentDictionary<string, Link> channels = new();
    private readonly SemaphoreSlim admissions = new(1);

    public async Task<Link> Open(AgentHello hello, string protocol, HttpContext context, CancellationToken ct)
    {
        var device = Secrets.Identifier(hello.DeviceId);
        var name = Secrets.Text(hello.Name);
        var proof = NotificationDeviceTrust.Proof(hello.NotificationKey);
        await admissions.WaitAsync(ct);
        try
        {
            if (links.TryGetValue(device, out var existing))
            {
                await Close(existing, ct, expiredOnly: true);
                if (links.ContainsKey(device))
                    throw Fault.Conflict("device_already_connected");
            }
            await registration.Register(device, name, ct);
            var link = new Link(device, protocol, context.Connection.RemoteIpAddress?.ToString(), proof);
            await Publish(link, CancellationToken.None, PresenceChange.Open);
            links[device] = link;
            if (link.Channel is { } channel)
                channels[channel] = link;
            return link;
        }
        finally
        {
            admissions.Release();
        }
    }

    public Link OpenChannel(HttpContext context)
    {
        var value = context.Request.Headers[ChannelHeader];
        if (value.Count != 1 || value[0] is not { Length: 43 } channel || !channels.TryGetValue(channel, out var link))
            throw new Fault(410, "agent_connection_ended");
        lock (link)
        {
            if (!Online(link))
                throw new Fault(410, "agent_connection_ended");
            return link;
        }
    }

    public AgentPresence Presence(string device, long? lastSeen = null)
    {
        if (!links.TryGetValue(device, out var link))
            return new(false, null, null, lastSeen is { } last ? Clock.At(last) : null, null, null, null, false, null);
        lock (link)
            return Read(link);
    }

    public string RequireAccess(string device, string? connectionId = null) => AccessibleLink(device, connectionId).Id;

    public Link AccessibleLink(string device, string? connectionId = null)
    {
        var link = Find(device);
        lock (link)
        {
            RequireAccess(link, connectionId);
            return link;
        }
    }

    public bool HasAccess(Link link) => AccessGeneration(link) is not null;

    public long? AccessGeneration(Link link)
    {
        lock (link)
            return Online(link) && link.AccessGranted ? link.AccessGeneration : null;
    }

    public long? AccessGeneration(string device, string? connection) =>
        links.TryGetValue(device, out var link) && link.Id == connection ? AccessGeneration(link) : null;

    public bool CanNotify(Link link)
    {
        lock (link)
            return Online(link) && (link.AccessGranted || link.NotificationTrusted);
    }

    public async Task<AgentPresence> SetAccess(string device, string connectionId, bool enabled, string actor, CancellationToken ct)
    {
        var link = Find(device);
        await link.Lifecycle.WaitAsync(ct);
        try
        {
            lock (link)
            {
                RequireOnline(link);
                RequireConnection(link, connectionId);
            }
            if (enabled && link.NotificationProof is not null)
                await trust.Bind(link, ct);

            lock (link)
            {
                RequireOnline(link);
                link.NotificationTrusted |= enabled && link.NotificationProof is not null;
                if (link.AccessGranted != enabled)
                {
                    link.AccessGeneration++;
                    link.AccessGranted = enabled;
                }
                if (!enabled)
                {
                    link.Windows.Clear();
                    FailPending(link, Fault.Forbidden("agent_connection_access_required"));
                }
            }
            await db.Audit("device.connection_access_changed", actor, device, new { connectionId, enabled }, CancellationToken.None);
            return await Publish(link, CancellationToken.None);
        }
        finally
        {
            link.Lifecycle.Release();
        }
    }

    public async Task Seen(Link link, CancellationToken ct, double? latency = null)
    {
        var now = Clock.Now;
        bool persist;
        AgentPresence? quality = null;
        lock (link)
        {
            RequireOnline(link);
            var tick = Stopwatch.GetTimestamp();
            persist = link.Seen != now;
            link.Seen = now;
            link.LastSignal = tick;
            link.Latency = latency ?? link.Latency;
            if (latency is not null && (link.QualityReported == 0 || Stopwatch.GetElapsedTime(link.QualityReported, tick).TotalSeconds >= 5))
            {
                link.QualityReported = tick;
                quality = Read(link);
            }
        }
        if (persist)
            await db.Execute("UPDATE Devices SET LastSeen=@now WHERE Id=@device AND LastSeen<@now AND Revoked IS NULL",
                new { now, device = link.Device }, ct);
        if (quality is not null)
            await db.AppendEvent(link.Device, "connection.quality", Wire.Element(quality), ct);
    }

    public async Task Expire(CancellationToken ct)
    {
        foreach (var link in links.Values)
        {
            lock (link)
                if (link.Windows.Expired)
                    link.Windows.Clear();
            await Close(link, ct, expiredOnly: true);
        }
    }

    public async Task Revoke(string device, CancellationToken ct)
    {
        await admissions.WaitAsync(ct);
        try
        {
            if (links.TryGetValue(device, out var link))
                await Close(link, ct);
        }
        finally
        {
            admissions.Release();
        }
    }

    public async Task Close(Link link, CancellationToken ct, bool expiredOnly = false)
    {
        await link.Lifecycle.WaitAsync(ct);
        try
        {
            lock (link)
            {
                if (link.Closed || expiredOnly && Online(link))
                    return;
                link.Closed = true;
                link.AccessGranted = false;
                link.Windows.Clear();
                FailPending(link, Fault.Unavailable());
            }
            if (link.Channel is { } channel)
                channels.TryRemove(channel, out _);
            try
            {
                await link.Cancel();
                await Publish(link, CancellationToken.None, PresenceChange.Close);
            }
            catch (Exception error)
            {
                logger.LogWarning(error, "Could not persist disconnect for agent {DeviceId}", link.Device);
            }
            finally
            {
                links.TryRemove(new KeyValuePair<string, Link>(link.Device, link));
            }
        }
        finally
        {
            link.Lifecycle.Release();
        }
    }

    public async Task<JsonElement> Invoke(string device, string kind, object payload, CancellationToken ct, string? commandId = null,
        TimeSpan? timeout = null, string? connectionId = null, Func<JsonElement, CancellationToken, Task>? progress = null)
    {
        var link = Find(device);
        var pending = new Pending(new AgentCommand("command", commandId ?? Secrets.Id(), kind, Wire.Element(payload)), progress);
        lock (link)
        {
            RequireAccess(link, connectionId);
            if (link.Pending.Count >= 24 || !link.Pending.TryAdd(pending.Command.Id, pending))
                throw new Fault(429, "device_busy");
            Wake(link);
        }
        try
        {
            var result = await pending.Completion.Task.WaitAsync(timeout ?? TimeSpan.FromSeconds(28), ct);
            if (result.Ok != true)
                throw RemoteFault(result.Code);
            return result.Payload ?? Wire.Element(new { });
        }
        catch (TimeoutException)
        {
            CancelCommand(link.Device, link.Id, pending.Command.Id);
            throw Fault.Unavailable("device_timeout");
        }
        finally
        {
            lock (link)
                if (link.Pending.GetValueOrDefault(pending.Command.Id) == pending)
                    link.Pending.Remove(pending.Command.Id);
        }
    }

    public async Task<IReadOnlyList<AgentCommand>> Commands(Link link, TimeSpan wait, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct, link.Lifetime);
        deadline.CancelAfter(wait);
        while (!deadline.IsCancellationRequested)
        {
            lock (link)
            {
                if (!Online(link))
                    return [];
                if (link.Cancellations.TryDequeue(out var cancellation))
                    return [cancellation];
                if (link.AccessGranted)
                {
                    var now = Stopwatch.GetTimestamp();
                    var ready = link.Pending.Values.Where(x => x.LeaseUntil <= now && !x.Completion.Task.IsCompleted)
                        .Take(3).ToArray();
                    if (ready.Length > 0)
                    {
                        foreach (var item in ready)
                            item.LeaseUntil = now + 8 * Stopwatch.Frequency;
                        return ready.Select(x => x.Command).ToArray();
                    }
                }
            }
            try
            {
                await link.Signal.WaitAsync(TimeSpan.FromSeconds(2), deadline.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return [];
            }
        }
        return [];
    }

    public void Complete(Link link, AgentFrame frame)
    {
        if (frame.Id is null)
            return;
        lock (link)
            if (Online(link) && link.AccessGranted && link.Pending.TryGetValue(frame.Id, out var pending))
                pending.Completion.TrySetResult(frame);
    }

    public void CancelCommand(string device, string connectionId, string id)
    {
        if (!links.TryGetValue(device, out var link) || link.Id != connectionId)
            return;
        lock (link)
        {
            if (!Online(link) || !link.Pending.TryGetValue(id, out var pending) || !pending.Completion.TrySetCanceled())
                return;
            if (link.Cancellations.Count < 24)
                link.Cancellations.Enqueue(new AgentCommand("cancel", id, "", Wire.Element<object?>(null)));
            Wake(link);
        }
    }

    public Task Progress(Link link, AgentFrame frame, CancellationToken ct)
    {
        if (frame is not { Id: { } id, Payload: { ValueKind: JsonValueKind.Object } payload })
            throw Fault.Bad("invalid_job_output");
        Func<JsonElement, CancellationToken, Task>? accept;
        lock (link)
        {
            accept = Online(link) && link.AccessGranted && link.Pending.TryGetValue(id, out var pending) &&
                !pending.Completion.Task.IsCompleted ? pending.Progress : null;
        }
        return accept?.Invoke(payload, ct) ?? Task.CompletedTask;
    }

    private Link Find(string device) => links.TryGetValue(device, out var link) ? link : throw Fault.Unavailable();

    private async Task<AgentPresence> Publish(Link link, CancellationToken ct, PresenceChange change = PresenceChange.None)
    {
        AgentPresence presence;
        lock (link)
            presence = Read(link);
        if (change == PresenceChange.None)
        {
            await db.AppendEvent(link.Device, "connection.changed", Wire.Element(presence), ct);
            return presence;
        }

        var trusted = await db.Write(async (connection, tx) =>
        {
            var now = Clock.Now;
            var source = await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@Device,'connection.changed',@now,@payload) RETURNING Sequence
                """, new { link.Device, now, payload = Wire.Encode(presence) }, tx, cancellationToken: ct));
            if (change == PresenceChange.Open)
                return await NotificationDeviceTrust.Connect(connection, tx, link, presence, source, now, ct);

            await NotificationDeviceTrust.Disconnect(connection, tx, link, presence, source, now,
                lifetime.ApplicationStopping.IsCancellationRequested, ct);
            return false;
        });
        if (trusted)
            lock (link)
                link.NotificationTrusted = true;
        return presence;
    }

    private static void RequireOnline(Link link)
    {
        if (!Online(link))
            throw Fault.Unavailable("agent_connection_ended");
    }

    private static void RequireConnection(Link link, string? id)
    {
        if (id is not null && id != link.Id)
            throw Fault.Conflict("agent_connection_changed");
    }

    private static void RequireAccess(Link link, string? id)
    {
        RequireOnline(link);
        RequireConnection(link, id);
        if (!link.AccessGranted)
            throw Fault.Forbidden("agent_connection_access_required");
    }

    private static bool Online(Link link) => !link.Closed && Stopwatch.GetElapsedTime(link.LastSignal) <= PresenceWindow;

    private static void FailPending(Link link, Fault error)
    {
        foreach (var item in link.Pending.Values)
            item.Completion.TrySetException(error);
        link.Pending.Clear();
        Wake(link);
    }

    private static void Wake(Link link)
    {
        if (link.Signal.CurrentCount == 0)
            link.Signal.Release();
    }

    private static AgentPresence Read(Link link) => Online(link)
        ? new(true, link.Protocol, Clock.At(link.Connected), Clock.At(link.Seen), link.Latency,
            (long)Stopwatch.GetElapsedTime(link.ConnectedTick).TotalSeconds, link.Id, link.AccessGranted, link.PeerAddress)
        : new(false, null, null, Clock.At(link.Seen), null, null, null, false, null);

    private static Fault RemoteFault(string? code) => code switch
    {
        "invalid_diagnostic_command" => Fault.Bad(code),
        "terminal_busy" or "terminal_closed" => Fault.Conflict(code),
        "permission_denied" or "filesystem_access_denied" or "invalid_path" or "notification_permission_required" or "interactive_session_required" => Fault.Forbidden(code),
        "not_found" => Fault.Missing(code),
        "version_mismatch" => new Fault(412, code),
        "already_exists" or "invalid_offset" or "snapshot_changed" or "directory_not_empty" or "trash_unavailable" or "delete_incomplete" or "cross_volume" or "root_identity_changed" => Fault.Conflict(code),
        "too_large" => new Fault(413, code),
        "limit_reached" => new Fault(429, code),
        "diagnostic_launch_failed" or "dialog_presentation_failed" => Fault.Unavailable(code),
        "local_authentication_unavailable" => new Fault(422, code),
        "unsupported" => new Fault(422, code),
        _ => Fault.Unavailable("device_operation_failed")
    };
}

internal static class SocketWire
{
    public static async Task<T?> Read<T>(WebSocket socket, int maximum, CancellationToken ct) where T : class
    {
        var buffer = new byte[16_384];
        using var message = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            if (result.MessageType == WebSocketMessageType.Close)
                return null;
            if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > maximum)
                throw Fault.Bad("invalid_message");
            message.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        return JsonSerializer.Deserialize<T>(message.GetBuffer().AsSpan(0, (int)message.Length), Wire.Json)
            ?? throw Fault.Bad("invalid_message");
    }

    public static async Task Send<T>(WebSocket socket, T message, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, Wire.Json);
        await socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, ct);
    }
}
