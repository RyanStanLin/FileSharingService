using System.Globalization;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed record NotificationSignal(string Type, DateTimeOffset At, IReadOnlyDictionary<string, string> Fields,
    double? Previous = null, double? Current = null);

internal static class NotificationMatcher
{
    public static async Task Match(SqliteConnection connection, SqliteTransaction tx, string device, long source, long now,
        IReadOnlyList<NotificationSignal> signals, CancellationToken ct)
    {
        if (signals.Count == 0)
            return;
        var rules = (await connection.QueryAsync<NotificationRuleRow>(new CommandDefinition("""
            SELECT r.* FROM NotificationRules r JOIN Devices d ON d.Id=r.DeviceId AND d.Revoked IS NULL
            WHERE r.DeviceId=@device AND r.Enabled=1 AND EXISTS (SELECT 1 FROM json_each(r.Events) WHERE value IN @types)
            ORDER BY r.Id
            """, new { device, types = signals.Select(signal => signal.Type).Distinct().ToArray() }, tx, cancellationToken: ct))).AsList();
        if (rules.Count == 0)
            return;

        var deviceName = await connection.QuerySingleAsync<string>(new CommandDefinition("SELECT Name FROM Devices WHERE Id=@device",
            new { device }, tx, cancellationToken: ct));
        var channels = (await connection.QueryAsync<NotificationChannelRow>(new CommandDefinition("""
            SELECT * FROM NotificationChannels WHERE Enabled=1 AND Id IN @ids
            """, new { ids = rules.SelectMany(rule => rule.Channels).Distinct().ToArray() }, tx, cancellationToken: ct)))
            .ToDictionary(channel => channel.Id, StringComparer.Ordinal);
        var capacity = await Capacity.Load(connection, tx, ct);

        foreach (var rule in rules)
        {
            var eventTypes = rule.EventTypes.ToHashSet(StringComparer.Ordinal);
            var filter = rule.Conditions;
            var targets = rule.Channels;
            var template = rule.Content;
            var recent = rule.CooldownSeconds == 0 ? null : await Cooldowns(connection, tx, rule.Id, ct);
            var sentTypes = new HashSet<string>(StringComparer.Ordinal);
            var matched = 0;
            var queued = 0;
            foreach (var signal in signals)
            {
                if (!eventTypes.Contains(signal.Type) || !Matches(signal, filter))
                    continue;
                matched++;
                if (recent is not null && recent.TryGetValue(signal.Type, out var last) && last > now - rule.CooldownSeconds)
                    continue;
                var destinations = targets.Where(target => channels.ContainsKey(target) && capacity.Allows(target)).ToArray();
                if (destinations.Length == 0)
                    continue;

                var fields = new Dictionary<string, string>(signal.Fields, StringComparer.Ordinal)
                {
                    ["event.type"] = signal.Type,
                    ["event.occurredAt"] = NotificationTemplates.Time(signal.At),
                    ["device.id"] = device,
                    ["device.name"] = deviceName
                };
                if (signal.Current is not null && filter.ThresholdPercent is { } threshold)
                    fields["metric.thresholdPercent"] = threshold.ToString(CultureInfo.InvariantCulture);
                var content = NotificationTemplates.Render(template, fields).Message;
                var work = new NotificationWork(rule.Id, rule.Revision, device, null, signal.Type, source,
                    signal.At.ToUnixTimeSeconds(), Wire.Encode(fields), content);
                var delivered = false;
                foreach (var target in destinations)
                {
                    if (!capacity.Allows(target))
                        continue;
                    await NotificationDeliveries.Enqueue(connection, tx, channels[target], work, ct);
                    capacity.Take(target);
                    delivered = true;
                    queued++;
                }
                if (delivered && recent is not null)
                {
                    recent[signal.Type] = now;
                    sentTypes.Add(signal.Type);
                }
            }

            if (matched == 0)
                continue;
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE NotificationRules SET MatchedEvents=MatchedEvents+@matched, EnqueuedDeliveries=EnqueuedDeliveries+@queued,
                    SkippedDeliveries=SkippedDeliveries+@skipped,LastMatched=@now WHERE Id=@Id
                """, new { rule.Id, matched, queued, skipped = matched * targets.Length - queued, now }, tx, cancellationToken: ct));
            foreach (var type in sentTypes)
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO NotificationCooldowns(RuleId,Event,LastQueued) VALUES(@Id,@type,@now)
                    ON CONFLICT(RuleId,Event) DO UPDATE SET LastQueued=excluded.LastQueued
                    """, new { rule.Id, type, now }, tx, cancellationToken: ct));
        }
    }

    private static bool Matches(NotificationSignal signal, NotificationFilter filter)
    {
        if (signal.Type.StartsWith("application.", StringComparison.Ordinal))
            return Equal(filter.BundleId, "app.bundleId", StringComparison.OrdinalIgnoreCase) &&
                Equal(filter.ApplicationId, "app.id", StringComparison.Ordinal);
        if (signal.Type.StartsWith("storage.", StringComparison.Ordinal))
            return Equal(filter.StorageId, "storage.id", StringComparison.Ordinal);
        if (signal is { Previous: { } old, Current: { } current } && filter.ThresholdPercent is { } threshold)
            return signal.Type is "battery.levelBelow" or "cpu.usageBelow" or "memory.usageBelow"
                ? old >= threshold && current < threshold : old < threshold && current >= threshold;
        return true;

        bool Equal(string? expected, string field, StringComparison comparison) =>
            expected is null || signal.Fields.TryGetValue(field, out var actual) && string.Equals(expected, actual, comparison);
    }

    private static async Task<Dictionary<string, long>> Cooldowns(SqliteConnection connection, SqliteTransaction tx, string id, CancellationToken ct) =>
        (await connection.QueryAsync<CooldownRow>(new CommandDefinition("""
            SELECT Event,LastQueued FROM NotificationCooldowns WHERE RuleId=@id
            """, new { id }, tx, cancellationToken: ct))).ToDictionary(row => row.Event, row => row.LastQueued, StringComparer.Ordinal);

    private sealed record CooldownRow(string Event, long LastQueued);
    private sealed record PendingRow(string ChannelId, long Count)
    {
        public PendingRow() : this("", 0) { }
    }

    private sealed class Capacity(Dictionary<string, long> pending)
    {
        private long total = pending.Values.Sum();

        public static async Task<Capacity> Load(SqliteConnection connection, SqliteTransaction tx, CancellationToken ct) =>
            new((await connection.QueryAsync<PendingRow>(new CommandDefinition("""
                SELECT ChannelId,COUNT(*) AS Count FROM NotificationDeliveries WHERE State IN ('queued','retryScheduled','sending')
                GROUP BY ChannelId
                """, transaction: tx, cancellationToken: ct))).ToDictionary(row => row.ChannelId, row => row.Count, StringComparer.Ordinal));

        public bool Allows(string channel) =>
            total < NotificationDeliveries.MaximumPending && pending.GetValueOrDefault(channel) < NotificationDeliveries.MaximumPerChannel;

        public void Take(string channel)
        {
            pending[channel] = pending.GetValueOrDefault(channel) + 1;
            total++;
        }
    }
}
