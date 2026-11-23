using System.Collections.Concurrent;
using System.Text.Json;
using Dapper;

namespace FileSharing;

/// <summary>A file notification directory and the rules sharing its current watch.</summary>
internal sealed record NotificationFileWatchView(string DeviceId, string RootId, string Path, IReadOnlyList<string> RuleIds,
    string State, DateTimeOffset? CheckedAt, string? Error);

internal sealed record NotificationWatchTarget(string DeviceId, string RootId, string Path);

internal sealed class NotificationFileWatches(Database db, AgentBroker broker, DeviceService devices, ILogger<NotificationFileWatches> logger)
    : BackgroundService
{
    public const int MaximumPerDevice = 8;
    private const int CheckInterval = 3;
    private const int RenewInterval = 12;
    private readonly ConcurrentDictionary<NotificationWatchTarget, WatchState> watches = new();

    public async Task<NotificationFileWatchView[]> List(string? deviceId, CancellationToken ct)
    {
        if (deviceId is not null)
            Secrets.Identifier(deviceId);
        var desired = await Desired(deviceId, ct);
        return desired.Select(group =>
        {
            var target = group.Key;
            var state = watches.GetValueOrDefault(target);
            return new NotificationFileWatchView(target.DeviceId, target.RootId, target.Path, group.Value,
                state?.State ?? "checking", state is null ? null : Clock.At(state.Checked), state?.Error);
        }).OrderBy(item => item.DeviceId).ThenBy(item => item.RootId).ThenBy(item => item.Path, StringComparer.Ordinal).ToArray();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(CheckInterval));
        do
        {
            try
            {
                var desired = await Desired(null, stoppingToken);
                // Scope quotas bound outstanding commands per device. A slow Mac must not delay another Mac's renewal.
                await Task.WhenAll(watches.Keys.Where(key => !desired.ContainsKey(key)).Select(target => Retire(target, stoppingToken)));
                await Task.WhenAll(desired.Keys.Select(target => Reconcile(target, stoppingToken)));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                logger.LogError(error, "Notification directory watch reconciliation failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task Receive(AgentBroker.Link link, string frameId, JsonElement payload, CancellationToken ct)
    {
        var id = NotificationSignals.Text(payload, "watchId", 36);
        if (id is null || !broker.HasAccess(link))
            return;
        var lease = watches.Values.Select(state => state.Lease).FirstOrDefault(watch =>
            watch is not null && watch.ConnectionId == link.Id && watch.DeviceId == link.Device && watch.Id == id);
        if (lease is null)
            return;
        try
        {
            await devices.Scope(lease.DeviceId, lease.RootId, false, ct, lease.ConnectionId);
        }
        catch (Fault)
        {
            return;
        }
        var now = Clock.Now;
        var signals = NotificationFileEvents.Parse(lease, payload, now);
        if (signals.Count == 0)
            return;
        var target = new NotificationWatchTarget(lease.DeviceId, lease.RootId, lease.Path);
        await db.Write(async (connection, tx) =>
        {
            if (watches.GetValueOrDefault(target)?.Lease?.Id != id || !broker.HasAccess(link))
                return false;
            var saved = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO AgentReceipts(DeviceId,FrameId,At)
                SELECT @DeviceId,@frameId,@now
                WHERE EXISTS(SELECT 1 FROM Roots r JOIN Devices d ON d.Id=r.DeviceId AND d.Revoked IS NULL
                    WHERE r.Id=@RootId AND r.DeviceId=@DeviceId AND r.Enabled=1)
                """, new { lease.DeviceId, lease.RootId, frameId, now }, tx, cancellationToken: ct));
            if (saved == 0)
                return false;

            var summary = Wire.Encode(new { watchId = lease.Id, lease.RootId, lease.Path, events = signals.Select(signal => signal.Type) });
            var source = await connection.QuerySingleAsync<long>(new CommandDefinition("""
                INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@DeviceId,'files.changed',@now,@summary) RETURNING Sequence
                """, new { lease.DeviceId, now, summary }, tx, cancellationToken: ct));
            await NotificationMatcher.Match(connection, tx, lease.DeviceId, source, now, signals, ct, target);
            return true;
        });
    }

    private async Task Retire(NotificationWatchTarget target, CancellationToken ct)
    {
        if (watches.TryRemove(target, out var state) && state.Lease is { } lease)
            await Stop(lease, ct);
    }

    private async Task Reconcile(NotificationWatchTarget target, CancellationToken ct)
    {
        var presence = broker.Presence(target.DeviceId);
        var state = watches.GetValueOrDefault(target);
        var lease = state?.Lease;
        if (lease is not null && (!presence.AccessGranted || lease.ConnectionId != presence.ConnectionId))
        {
            watches.TryRemove(target, out _);
            await Stop(lease, ct);
            lease = null;
        }
        if (!presence.Online || !presence.AccessGranted)
        {
            watches[target] = new(null, presence.Online ? "awaitingAuthorization" : "waitingForConnection", Clock.Now);
            return;
        }
        if (lease is not null && state!.Checked > Clock.Now - RenewInterval)
            return;

        try
        {
            var root = await devices.Scope(target.DeviceId, target.RootId, false, ct, presence.ConnectionId);
            lease ??= new Watch(Secrets.Id(), target.DeviceId, target.RootId, root.RootKey, target.Path, root.ConnectionId!);
            watches[target] = new(lease, state?.State == "active" ? "active" : "starting", Clock.Now);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(6));
            var result = await broker.Invoke(target.DeviceId, "files.watch", new
            {
                watchId = lease.Id, root = lease.RootKey, lease.Path, seconds = 40, purpose = NotificationFileEvents.Purpose
            }, deadline.Token, connectionId: lease.ConnectionId);
            if (NotificationSignals.Text(result, "purpose") != NotificationFileEvents.Purpose)
                throw new Fault(422, "notification_watch_requires_agent_upgrade");
            watches[target] = new(lease, "active", Clock.Now);
        }
        catch (Exception error) when (error is Fault || error is OperationCanceledException && !ct.IsCancellationRequested)
        {
            watches[target] = new(null, "unavailable", Clock.Now, (error as Fault)?.Code ?? "device_timeout");
            if (lease is not null)
                await Stop(lease, ct);
        }
    }

    private async Task Stop(Watch watch, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            await broker.Invoke(watch.DeviceId, "files.unwatch", new { watchId = watch.Id }, deadline.Token, connectionId: watch.ConnectionId);
        }
        catch (Exception error) when (error is Fault || error is OperationCanceledException && !ct.IsCancellationRequested)
        {
        }
    }

    private async Task<Dictionary<NotificationWatchTarget, string[]>> Desired(string? device, CancellationToken ct)
    {
        var rules = await db.List<WatchRule>("""
            SELECT r.Id, r.DeviceId, CAST(json_extract(r.Filter,'$.file.rootId') AS TEXT) AS RootId,
                CAST(json_extract(r.Filter,'$.file.path') AS TEXT) AS Path
            FROM NotificationRules r JOIN Devices d ON d.Id=r.DeviceId AND d.Revoked IS NULL
            WHERE r.Enabled=1 AND (@device IS NULL OR r.DeviceId=@device) AND json_type(r.Filter,'$.file')='object'
              AND EXISTS(SELECT 1 FROM json_each(r.ChannelIds) targets JOIN NotificationChannels c ON c.Id=targets.value WHERE c.Enabled=1)
            ORDER BY r.Id
            """, new { device }, ct);
        return rules.GroupBy(rule => new NotificationWatchTarget(rule.DeviceId, rule.RootId, rule.Path))
            .ToDictionary(group => group.Key, group => group.Select(rule => rule.Id).ToArray());
    }

    private sealed record WatchRule(string Id, string DeviceId, string RootId, string Path)
    {
        public WatchRule() : this("", "", "", "") { }
    }

    private sealed record WatchState(Watch? Lease, string State, long Checked, string? Error = null);
}
