using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;

namespace FileSharing;

internal sealed record AgentCommand(string Type, string Id, string Kind, JsonElement Payload);
internal sealed record AgentFrame(string Type, string? Id, string? Topic, string? Code, JsonElement? Payload, bool? Ok, bool? Snapshot);
internal sealed record AgentPresence(bool Online, string? Protocol, DateTimeOffset? ConnectedAt, DateTimeOffset? LastCommunicationAt,
    double? LatencyMs, long? ConnectionSeconds);

internal sealed class AgentBroker(Database db)
{
    private sealed class Pending(AgentCommand command)
    {
        public AgentCommand Command { get; } = command;
        public TaskCompletionSource<AgentFrame> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public long LeaseUntil { get; set; }
    }

    private sealed class Link
    {
        public Dictionary<string, Pending> Pending { get; } = [];
        public SemaphoreSlim Signal { get; } = new(0, 1);
        public long? Seen { get; set; }
        public long? Connected { get; set; }
        public string? Protocol { get; set; }
        public double? Latency { get; set; }
    }

    private readonly ConcurrentDictionary<string, Link> links = new();

    public AgentPresence Presence(string device, long? lastSeen = null)
    {
        if (!links.TryGetValue(device, out var link))
            return new(false, null, null, lastSeen is { } last ? Clock.At(last) : null, null, null);
        lock (link)
            return Read(link);
    }

    public async Task Seen(string device, string protocol, CancellationToken ct, double? latency = null)
    {
        var link = links.GetOrAdd(device, _ => new());
        var now = Clock.Now;
        bool changed;
        bool persist;
        AgentPresence presence;
        lock (link)
        {
            changed = link.Seen is null || now - link.Seen > 45 || link.Protocol != protocol;
            persist = changed || link.Seen != now;
            if (changed)
            {
                link.Connected = now;
                link.Latency = null;
            }
            link.Seen = now;
            link.Protocol = protocol;
            link.Latency = latency ?? link.Latency;
            presence = Read(link);
        }
        if (persist)
            await db.Execute("UPDATE Devices SET LastSeen=@now WHERE Id=@device", new { now, device }, ct);
        if (changed)
            await db.AppendEvent(device, "connection.changed", Wire.Element(presence), ct);
    }

    public async Task Expire(CancellationToken ct)
    {
        foreach (var entry in links)
        {
            AgentPresence? state = null;
            var link = entry.Value;
            lock (link)
            {
                if (link.Protocol is not null && Clock.Now - link.Seen > 45)
                {
                    link.Protocol = null;
                    link.Connected = null;
                    link.Latency = null;
                    state = Read(link);
                }
            }
            if (state is not null)
                await db.AppendEvent(entry.Key, "connection.changed", Wire.Element(state), ct);
        }
    }

    public void Revoke(string device)
    {
        if (!links.TryRemove(device, out var link))
            return;
        lock (link)
        {
            foreach (var item in link.Pending.Values)
                item.Completion.TrySetException(Fault.Unavailable());
            link.Pending.Clear();
            Wake(link);
        }
    }

    public async Task<JsonElement> Invoke(string device, string kind, object payload, CancellationToken ct, string? commandId = null, TimeSpan? timeout = null)
    {
        var link = links.GetOrAdd(device, _ => new());
        var pending = new Pending(new AgentCommand("command", commandId ?? Secrets.Id(), kind, Wire.Element(payload)));
        lock (link)
        {
            if (!Read(link).Online)
                throw Fault.Unavailable();
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
            throw Fault.Unavailable("device_timeout");
        }
        finally
        {
            lock (link)
                link.Pending.Remove(pending.Command.Id);
        }
    }

    public async Task<IReadOnlyList<AgentCommand>> Commands(string device, TimeSpan wait, CancellationToken ct)
    {
        var link = links.GetOrAdd(device, _ => new());
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(wait);
        while (!deadline.IsCancellationRequested)
        {
            lock (link)
            {
                var now = Clock.Now;
                var ready = link.Pending.Values.Where(x => x.LeaseUntil <= now && !x.Completion.Task.IsCompleted)
                    .Take(3).ToArray();
                if (ready.Length > 0)
                {
                    foreach (var item in ready)
                        item.LeaseUntil = now + 8;
                    return ready.Select(x => x.Command).ToArray();
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

    public void Complete(string device, AgentFrame frame)
    {
        if (frame.Id is null || !links.TryGetValue(device, out var link))
            return;
        lock (link)
            if (link.Pending.TryGetValue(frame.Id, out var pending))
                pending.Completion.TrySetResult(frame);
    }

    private static void Wake(Link link)
    {
        if (link.Signal.CurrentCount == 0)
            link.Signal.Release();
    }

    private static AgentPresence Read(Link link)
    {
        var now = Clock.Now;
        var online = link.Protocol is not null && link.Seen is { } seen && now - seen <= 45;
        return new(online, online ? link.Protocol : null, online && link.Connected is { } start ? Clock.At(start) : null,
            link.Seen is { } last ? Clock.At(last) : null, online ? link.Latency : null,
            online ? now - link.Connected : null);
    }

    private static Fault RemoteFault(string? code) => code switch
    {
        "permission_denied" or "invalid_path" => Fault.Forbidden(code),
        "not_found" => Fault.Missing(code),
        "version_mismatch" => new Fault(412, code),
        "already_exists" or "invalid_offset" or "snapshot_changed" or "directory_not_empty" or "trash_unavailable" or "delete_incomplete" or "cross_volume" => Fault.Conflict(code),
        "too_large" => new Fault(413, code),
        "limit_reached" => new Fault(429, code),
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
