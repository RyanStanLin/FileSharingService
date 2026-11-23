using System.Globalization;
using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal static class NotificationSignals
{
    public static async Task<IReadOnlyList<NotificationSignal>> FromFrame(SqliteConnection connection, SqliteTransaction tx,
        string device, string topic, bool snapshot, JsonElement payload, long now, CancellationToken ct)
    {
        if (!snapshot)
            return Direct(topic, payload, now) is { } signal ? [signal] : [];
        var observed = topic switch
        {
            "battery" => Fields(("battery.chargePercent", Value(payload, "chargePercent")),
                ("battery.charging", Value(payload, "charging")), ("battery.externalPower", Value(payload, "externalPower"))),
            "power" => Fields(("lowPowerMode", Value(payload, "lowPowerMode"))),
            "cpu" or "memory" => Fields(("metric.value", Value(payload, "usagePercent"))),
            "network" => Fields(("network.reachability", Value(payload, "reachability")),
                ("network.interface", Value(payload, "primaryInterface")), ("network.vpn", Value(payload, "vpn"))),
            "displays" => DisplaySample(payload),
            _ => null
        };
        if (observed is not { Count: > 0 })
            return [];

        var current = Wire.Encode(observed);
        var stored = await connection.QuerySingleOrDefaultAsync<string>(new CommandDefinition("""
            SELECT Payload FROM NotificationSamples WHERE DeviceId=@device AND Topic=@topic
            """, new { device, topic }, tx, cancellationToken: ct));
        if (stored == current)
            return [];
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO NotificationSamples(DeviceId,Topic,Payload) VALUES(@device,@topic,@current)
            ON CONFLICT(DeviceId,Topic) DO UPDATE SET Payload=excluded.Payload
            """, new { device, topic, current }, tx, cancellationToken: ct));
        if (stored is null)
            return [];
        var previous = Wire.Model<Dictionary<string, string>>(Wire.Parse(stored));
        return Transitions(topic, previous, observed, Clock.At(now));
    }

    public static NotificationSignal Presence(AgentBroker.Link link, AgentPresence presence, bool online, long now) =>
        new(online ? "device.online" : "device.offline", Clock.At(now), Fields(
            ("connection.id", link.Id), ("connection.protocol", link.Protocol),
            ("connection.lastSeenAt", presence.LastCommunicationAt is { } last ? NotificationTemplates.Time(last) : null)));

    private static NotificationSignal? Direct(string topic, JsonElement payload, long now)
    {
        if (payload.ValueKind != JsonValueKind.Object)
            return null;
        var kind = Text(payload, "kind");
        var type = topic switch
        {
            "applications.changed" => $"application.{kind}",
            "storage.changed" => $"storage.{kind}",
            "lid.changed" => Get(payload, "lidClosed").ValueKind switch
            {
                JsonValueKind.True => "lid.closed",
                JsonValueKind.False => "lid.opened",
                _ => null
            },
            "system.changed" => kind switch
            {
                "sleeping" => "system.sleeping",
                "woke" => "system.woke",
                "locked" => "system.locked",
                "unlocked" => "system.unlocked",
                "displaySlept" => "display.slept",
                "displayWoke" => "display.woke",
                _ => null
            },
            "clipboard.changed" or "telemetry.gap" => topic,
            _ => null
        };
        if (NotificationCatalog.Find(type) is null)
            return null;
        var timestamp = Get(payload, topic == "telemetry.gap" ? "observedAt" : "occurredAt");
        if (timestamp.ValueKind != JsonValueKind.String || !timestamp.TryGetDateTimeOffset(out var occurred))
            return null;
        var age = now - occurred.ToUnixTimeSeconds();
        if (age is < -300 or > 600)
            return null;

        var fields = topic switch
        {
            "applications.changed" => Application(Get(payload, "application")),
            "storage.changed" => Storage(Get(payload, "storage")),
            "lid.changed" => Fields(("lid.closed", Value(payload, "lidClosed"))),
            _ => []
        };
        if (topic is "applications.changed" or "storage.changed" && fields.Count == 0)
            return null;
        return new(type!, occurred, fields);
    }

    private static IReadOnlyList<NotificationSignal> Transitions(string topic, Dictionary<string, string> previous,
        Dictionary<string, string> observed, DateTimeOffset at)
    {
        var transitions = new List<NotificationSignal>();
        switch (topic)
        {
            case "battery":
                BooleanTransition("battery.externalPower", "battery.externalConnected", "battery.externalDisconnected", observed);
                BooleanTransition("battery.charging", "battery.chargingStarted", "battery.chargingStopped", observed);
                MetricTransition("battery.chargePercent", "battery.levelRecovered", "battery.levelBelow", observed);
                break;
            case "power":
                BooleanTransition("lowPowerMode", "power.lowPowerEnabled", "power.lowPowerDisabled", []);
                break;
            case "cpu":
            case "memory":
                MetricTransition("metric.value", topic + ".usageAbove", topic + ".usageBelow", []);
                break;
            case "network":
                var old = previous.GetValueOrDefault("network.reachability");
                var value = observed.GetValueOrDefault("network.reachability");
                var fields = new Dictionary<string, string>(observed, StringComparer.Ordinal);
                if (old is "reachable" or "unavailable")
                    fields["network.previousReachability"] = old;
                transitions.Add(new("network.changed", at, fields));
                if (old is "reachable" or "unavailable" && value is "reachable" or "unavailable" && old != value)
                    transitions.Add(new("network." + value, at, fields));
                break;
            case "displays":
                transitions.Add(new("display.configurationChanged", at, Fields(
                    ("display.count", observed.GetValueOrDefault("count")), ("display.previousCount", previous.GetValueOrDefault("count")))));
                break;
        }
        return transitions;

        void BooleanTransition(string field, string whenTrue, string whenFalse, Dictionary<string, string> fields)
        {
            var before = previous.GetValueOrDefault(field);
            var after = observed.GetValueOrDefault(field);
            if (before is "true" or "false" && after is "true" or "false" && before != after)
                transitions.Add(new(after == "true" ? whenTrue : whenFalse, at, fields));
        }

        void MetricTransition(string field, string rising, string falling, Dictionary<string, string> fields)
        {
            if (!Percent(previous.GetValueOrDefault(field), out var before) || !Percent(observed.GetValueOrDefault(field), out var after) ||
                before == after)
                return;
            var context = new Dictionary<string, string>(fields, StringComparer.Ordinal)
            {
                ["metric.value"] = observed[field],
                ["metric.previousValue"] = previous[field]
            };
            transitions.Add(new(after > before ? rising : falling, at, context, before, after));
        }
    }

    private static bool Percent(string? value, out double percent) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out percent) && percent is >= 0 and <= 100;

    private static Dictionary<string, string> DisplaySample(JsonElement payload)
    {
        var items = Get(payload, "items");
        var count = Value(payload, "count");
        if (count is null || items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > 64)
            return [];
        var signature = items.EnumerateArray().Select(item =>
            new[] { Value(item, "id"), Value(item, "width"), Value(item, "height"), Value(item, "refreshRateHz"), Value(item, "active") })
            .Select(row => Wire.Encode(row)).Order(StringComparer.Ordinal);
        return new(StringComparer.Ordinal) { ["count"] = count, ["signature"] = Secrets.Hash(string.Join('\n', signature)) };
    }

    private static Dictionary<string, string> Application(JsonElement app) => Fields(
        ("app.name", Text(app, "name")), ("app.bundleId", Text(app, "bundleId")), ("app.id", Text(app, "applicationId")),
        ("app.version", Text(app, "version")), ("app.build", Text(app, "build")), ("app.pid", Value(app, "pid")));

    private static Dictionary<string, string> Storage(JsonElement storage) => Fields(
        ("storage.id", Text(storage, "id")), ("storage.name", Text(storage, "name")),
        ("storage.mountPath", Text(storage, "mountPath", 3000) ?? Text(storage, "lastMountPath", 3000)),
        ("storage.fileSystem", Text(storage, "fileSystem")), ("storage.transport", Text(storage, "transport")),
        ("storage.capacityBytes", Value(storage, "capacityBytes")));

    internal static Dictionary<string, string> Fields(params (string Key, string? Value)[] pairs)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in pairs)
            if (value is not null)
                values.Add(key, value);
        return values;
    }

    internal static string? Value(JsonElement payload, string key) => Get(payload, key) switch
    {
        { ValueKind: JsonValueKind.True } => "true",
        { ValueKind: JsonValueKind.False } => "false",
        { ValueKind: JsonValueKind.Number } number when number.TryGetDouble(out var value) && double.IsFinite(value) &&
            number.GetRawText().Length <= 40 => number.GetRawText(),
        { ValueKind: JsonValueKind.String } text => Safe(text.GetString(), 256),
        _ => null
    };

    internal static string? Text(JsonElement payload, string key, int max = 256) =>
        Get(payload, key) is { ValueKind: JsonValueKind.String } text ? Safe(text.GetString(), max) : null;

    private static string? Safe(string? value, int max) =>
        value is { Length: > 0 } && value.Length <= max && !value.Any(char.IsControl) ? value : null;

    internal static JsonElement Get(JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var element) ? element : default;
}
