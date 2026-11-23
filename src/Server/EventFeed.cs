using System.Globalization;
using System.Net.WebSockets;
using System.Text.Json;

namespace FileSharing;

internal sealed record EventRow(long Sequence, string DeviceId, string Topic, long At, string Payload)
{
    public EventView View => new(Sequence.ToString(CultureInfo.InvariantCulture), DeviceId, Topic, Clock.At(At), Wire.Parse(Payload));
}
internal sealed record EventView(string Sequence, string? DeviceId, string Topic, DateTimeOffset Time, JsonElement Payload);
internal sealed record EventsPage(IReadOnlyList<EventView> Items, string Cursor, bool HasMore);
internal sealed record SubscriptionInput(string Type, string? Id, string? DeviceId, string? Topic, string? RootId, string? Path, string? After);
internal sealed record Subscription(string Id, string? DeviceId, string Topic, long Cursor, Watch? Watch, WindowSubscription? Windows = null);
internal sealed record WindowSubscription(WindowLease Lease, string? Revision);
internal sealed record Watch(string Id, string DeviceId, string RootId, string RootKey, string Path, string ConnectionId);

internal sealed class WatchRegistry(DeviceService devices, AgentBroker broker, Database db)
{
    private readonly Dictionary<(string Device, string Root, string Path, string Connection), (Watch Watch, int Count)> watches = [];
    private readonly object gate = new();

    public async Task<Watch> Add(string device, string rootId, string path, CancellationToken ct)
    {
        var pathKey = FileService.PathKey(path);
        var root = await devices.Scope(device, rootId, false, ct);
        var connection = root.ConnectionId!;
        var key = (device, rootId, pathKey, connection);
        Watch watch;
        lock (gate)
        {
            if (watches.TryGetValue(key, out var existing))
            {
                watches[key] = (existing.Watch, existing.Count + 1);
                return existing.Watch;
            }
            if (watches.Keys.Count(x => x.Device == device && x.Connection == connection) >= 4)
                throw new Fault(429, "watch_limit");
            watch = new Watch(Secrets.Id(), device, rootId, root.RootKey, pathKey, connection);
            watches[key] = (watch, 1);
        }
        try
        {
            await Start(watch, ct);
            return watch;
        }
        catch
        {
            await Remove(watch, CancellationToken.None);
            throw;
        }
    }

    private Task<JsonElement> Start(Watch watch, CancellationToken ct) =>
        broker.Invoke(watch.DeviceId, "files.watch", new { watchId = watch.Id, root = watch.RootKey, watch.Path, seconds = 40 }, ct, connectionId: watch.ConnectionId);

    public async Task Remove(Watch watch, CancellationToken ct)
    {
        var key = (watch.DeviceId, watch.RootId, watch.Path, watch.ConnectionId);
        lock (gate)
        {
            if (!watches.TryGetValue(key, out var existing) || existing.Watch.Id != watch.Id)
                return;
            if (existing.Count > 1)
            {
                watches[key] = (watch, existing.Count - 1);
                return;
            }
            watches.Remove(key);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            await broker.Invoke(watch.DeviceId, "files.unwatch", new { watchId = watch.Id }, timeout.Token, connectionId: watch.ConnectionId);
        }
        catch (Exception error) when (error is Fault or OperationCanceledException)
        {
        }
    }

    public async Task Renew(CancellationToken ct)
    {
        Watch[] active;
        lock (gate)
            active = watches.Values.Select(x => x.Watch).ToArray();
        await Task.WhenAll(active.Select(RenewWatch));

        async Task RenewWatch(Watch watch)
        {
            try
            {
                await devices.Scope(watch.DeviceId, watch.RootId, false, ct, watch.ConnectionId);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(5));
                await Start(watch, timeout.Token);
            }
            catch (Exception error) when (error is Fault or OperationCanceledException)
            {
            }
        }
    }

    public async Task Ingest(string device, string connection, JsonElement value, CancellationToken ct)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("watchId", out var id) || id.ValueKind != JsonValueKind.String)
            throw Fault.Bad("invalid_file_event");
        Watch? watch;
        lock (gate)
            watch = watches.Values.Select(x => x.Watch).FirstOrDefault(x => x.DeviceId == device && x.ConnectionId == connection && x.Id == id.GetString());
        if (watch is null)
            return;
        try
        {
            await devices.Scope(device, watch.RootId, false, ct, connection);
        }
        catch (Fault)
        {
            return;
        }
        await db.AppendEvent(device, "files.changed", Wire.Element(new { watchId = watch.Id, watch.RootId, watch.Path, change = value }), ct);
    }
}

internal sealed class EventFeed(Database db)
{
    public static bool Known(string topic) => AgentIngest.SnapshotTopics.Contains(topic) ||
        topic is "connection.changed" or "applications.changed" or "storage.changed" or "system.changed" or "telemetry.gap" or
            "files.changed" or "transfers.changed" or "jobs.changed" or "jobs.output" or "connection.quality" or "clipboard.changed" or "lid.changed";

    public static long Cursor(string? raw) => raw is null ? 0 :
        long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n >= 0 ? n : throw Fault.Bad("invalid_cursor");

    public Task<long> Head(CancellationToken ct) =>
        db.One<long>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='Events'),0)", null, ct);

    public async Task EnsureCursor(long after, CancellationToken ct)
    {
        if (after == 0)
            return;
        var first = await db.One<long>("SELECT COALESCE(MIN(Sequence),0) FROM Events", null, ct);
        if (after < first - 1 || after > await Head(ct))
            throw new Fault(410, "resync_required");
    }

    public async Task<EventsPage> Read(long after, string? device, string? topic, int take, bool files, CancellationToken ct, long? from = null, long? to = null)
    {
        var rows = await db.List<EventRow>("""
            SELECT e.* FROM Events e JOIN Devices d ON d.Id=e.DeviceId AND d.Revoked IS NULL
            WHERE e.Sequence>@after AND (@device IS NULL OR e.DeviceId=@device) AND (@topic IS NULL OR e.Topic=@topic)
                  AND (@from IS NULL OR e.At>=@from) AND (@to IS NULL OR e.At<=@to)
                  AND (@files=1 OR e.Topic<>'files.changed') ORDER BY e.Sequence LIMIT @size
            """, new { after, device, topic, files, from, to, size = take + 1 }, ct);
        var items = rows.Take(take).Select(x => x.View).ToArray();
        return new(items, items.LastOrDefault()?.Sequence ?? after.ToString(CultureInfo.InvariantCulture), rows.Count > take);
    }
}

internal static class BrowserEvents
{
    public static async Task Handle(HttpContext context, ReviewService reviews, Settings settings, EventFeed feed, DeviceService devices,
        WatchRegistry watches, WindowFeed windows, NotificationUpdates notifications, CancellationToken ct)
    {
        ReviewService.RequireOrigin(context, settings);
        var review = await reviews.Require(context, ct);
        if (!context.WebSockets.IsWebSocketRequest)
            throw Fault.Bad("websocket_required");
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var subscriptions = new Dictionary<string, Subscription>();
        var life = stop.Token;
        var input = SocketWire.Read<SubscriptionInput>(socket, 8192, life);
        try
        {
            await SocketWire.Send(socket, new { type = "ready", cursor = (await feed.Head(life)).ToString() }, life);
            while (!life.IsCancellationRequested)
            {
                if (await reviews.ActiveById(review.Id, life) is null)
                {
                    await socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "review_ended", life);
                    try
                    {
                        await input.WaitAsync(TimeSpan.FromSeconds(2), life);
                    }
                    catch (TimeoutException)
                    {
                    }
                    break;
                }

                var pending = new List<Task> { input, Task.Delay(500, life) };
                foreach (var sub in subscriptions.Values)
                    if (sub.Windows is { } window)
                        pending.Add(windows.NextChange(window.Lease, window.Revision));
                if (await Task.WhenAny(pending) == input)
                {
                    var command = await input;
                    if (command is null)
                    {
                        await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", life);
                        break;
                    }
                    await Process(command);
                    input = SocketWire.Read<SubscriptionInput>(socket, 8192, life);
                }

                foreach (var sub in subscriptions.Values.ToArray())
                    await Deliver(sub);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or JsonException or Fault)
        {
            socket.Abort();
        }
        finally
        {
            await stop.CancelAsync();
            await Task.WhenAll(subscriptions.Values.Where(s => s.Watch is not null)
                .Select(s => watches.Remove(s.Watch!, CancellationToken.None)));
        }

        async Task Process(SubscriptionInput command)
        {
            try
            {
                var id = Secrets.Text(command.Id, 64);
                switch (command.Type)
                {
                    case "unsubscribe":
                        if (subscriptions.Remove(id, out var previous) && previous.Watch is { } watch)
                            await watches.Remove(watch, life);
                        await SocketWire.Send(socket, new { type = "unsubscribed", id }, life);
                        return;
                    case "subscribe":
                        if (subscriptions.Count >= 16 || subscriptions.ContainsKey(id))
                            throw Fault.Conflict("subscription_limit_or_duplicate");
                        var topic = Secrets.Text(command.Topic, 35);
                        if (topic == NotificationUpdates.Topic)
                        {
                            if (command.DeviceId is not null || command.RootId is not null || command.Path is not null)
                                throw Fault.Bad("invalid_notification_subscription_scope");
                            var cursor = command.After is null ? await notifications.Head(life) : EventFeed.Cursor(command.After);
                            await notifications.EnsureCursor(cursor, life);
                            subscriptions.Add(id, new(id, null, topic, cursor, null));
                            await SocketWire.Send(socket, new { type = "subscribed", id, cursor = cursor.ToString(), snapshotRequired = false }, life);
                            return;
                        }
                        var device = await devices.Require(Secrets.Identifier(command.DeviceId), life);
                        if (topic == WindowFeed.Topic)
                        {
                            var revision = WindowFeed.Revision(command.After);
                            var lease = await windows.Open(device.Id, life);
                            subscriptions.Add(id, new(id, device.Id, topic, 0, null, new(lease, revision)));
                            await SocketWire.Send(socket, new { type = "subscribed", id, cursor = revision, snapshotRequired = false }, life);
                            return;
                        }
                        if (!EventFeed.Known(topic))
                            throw Fault.Bad("invalid_topic");
                        var after = command.After is null ? await feed.Head(life) : EventFeed.Cursor(command.After);
                        await feed.EnsureCursor(after, life);
                        var newWatch = topic == "files.changed"
                            ? await watches.Add(device.Id, Secrets.Identifier(command.RootId), command.Path ?? "", life) : null;
                        subscriptions.Add(id, new Subscription(id, device.Id, topic, after, newWatch));
                        await SocketWire.Send(socket, new { type = "subscribed", id, cursor = after.ToString(), snapshotRequired = newWatch is not null }, life);
                        return;
                    default:
                        throw Fault.Bad("invalid_operation");
                }
            }
            catch (Fault error)
            {
                await SocketWire.Send(socket, new { type = "error", command.Id, code = error.Code }, life);
            }
        }

        async Task Deliver(Subscription sub)
        {
            if (sub.Windows is { } window)
            {
                try
                {
                    await windows.Renew(window.Lease, life);
                    if (await windows.Read(window.Lease, window.Revision, 0, life) is not { } current)
                        return;
                    var item = new EventView(current.Revision, sub.DeviceId, sub.Topic, current.ObservedAt, Wire.Element(current));
                    await SocketWire.Send(socket, new { type = "event", id = sub.Id, item }, life);
                    subscriptions[sub.Id] = sub with { Windows = window with { Revision = current.Revision } };
                }
                catch (Fault error)
                {
                    subscriptions.Remove(sub.Id);
                    await SocketWire.Send(socket, new { type = "error", sub.Id, code = error.Code }, life);
                }
                return;
            }
            if (sub.Watch is { } watch)
            {
                try
                {
                    await devices.Scope(watch.DeviceId, watch.RootId, false, life, watch.ConnectionId);
                }
                catch (Fault error)
                {
                    subscriptions.Remove(sub.Id);
                    await watches.Remove(watch, life);
                    await SocketWire.Send(socket, new { type = "error", sub.Id, code = error.Code }, life);
                    return;
                }
            }
            var batch = sub.Topic == NotificationUpdates.Topic
                ? await notifications.Read(sub.Cursor, 50, life)
                : await feed.Read(sub.Cursor, sub.DeviceId, sub.Topic, 50, sub.Watch is not null, life);
            foreach (var item in batch.Items)
            {
                if (sub.Watch is not null &&
                    (!item.Payload.TryGetProperty("watchId", out var watchId) || watchId.GetString() != sub.Watch.Id))
                    continue;
                await SocketWire.Send(socket, new { type = "event", id = sub.Id, item }, life);
            }
            subscriptions[sub.Id] = sub with { Cursor = EventFeed.Cursor(batch.Cursor) };
        }
    }
}
