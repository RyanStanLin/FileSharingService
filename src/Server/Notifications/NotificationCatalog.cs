using System.Text.Json.Serialization;

namespace FileSharing;

/// <summary>A variable clients can insert into notification templates.</summary>
internal sealed record NotificationVariable(string Name, string Description);

/// <summary>A supported notification event and its accepted rule fields.</summary>
internal sealed record NotificationEventType(string Type, string Description, IReadOnlyList<NotificationVariable> Variables,
    IReadOnlyList<string> Filters);

/// <summary>The notification event catalogue and relevant configuration limits.</summary>
internal sealed record NotificationCatalogView(IReadOnlyList<NotificationEventType> Events, bool CredentialsEnabled,
    int MaximumRules, int MaximumChannels, int MaximumChannelsPerRule, int MaximumDirectoriesPerDevice);

/// <summary>Optional exact-match fields and a sampled-metric crossing threshold.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationFilter(string? BundleId, string? ApplicationId, string? StorageId, int? ThresholdPercent,
    NotificationFileFilter? File = null);

/// <summary>Plain-text title and body with allowlisted double-brace variable substitution.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationTemplate(string? Title, string Body);

/// <summary>A group of events on one device, fanned out to the selected channels.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationRuleRequest(string Name, string DeviceId, bool Enabled, IReadOnlyList<string> Events,
    IReadOnlyList<string> ChannelIds, NotificationTemplate Template, NotificationFilter? Filter, int? CooldownSeconds, long? Revision);

/// <summary>A notification rule with revision and cumulative matching counters.</summary>
internal sealed record NotificationRuleView(string Id, string Name, string DeviceId, bool Enabled, long Revision,
    IReadOnlyList<string> Events, IReadOnlyList<string> ChannelIds, NotificationTemplate Template, NotificationFilter Filter,
    int CooldownSeconds, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long MatchedEvents, long EnqueuedDeliveries,
    long SkippedDeliveries, DateTimeOffset? LastMatchedAt);

/// <summary>A template to render against sample context without sending a message.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationPreviewRequest(string Event, NotificationTemplate Template, IReadOnlyDictionary<string, string>? Context,
    IReadOnlyList<string>? Events = null);

/// <summary>Rendered notification content and the variables that were missing.</summary>
internal sealed record NotificationPreview(NotificationMessage Message, IReadOnlyList<string> MissingVariables);

internal static class NotificationCatalog
{
    private static readonly NotificationVariable[] Common =
    [
        new("event.type", "Notification event identifier."),
        new("event.occurredAt", "Event time in ISO 8601 UTC."),
        new("device.id", "FileSharing device UUID."),
        new("device.name", "Current administrator-visible device name.")
    ];
    private static readonly NotificationVariable[] Application =
    [
        new("app.name", "Application name."),
        new("app.bundleId", "macOS bundle identifier."),
        new("app.id", "FileSharing application identifier."),
        new("app.version", "Application marketing version."),
        new("app.build", "Application build version."),
        new("app.pid", "Process identifier when available.")
    ];
    private static readonly NotificationVariable[] Storage =
    [
        new("storage.id", "Storage identifier on this device."),
        new("storage.name", "Volume or device name."),
        new("storage.mountPath", "Current or last mount path."),
        new("storage.fileSystem", "File system type."),
        new("storage.transport", "Storage transport reported by macOS."),
        new("storage.capacityBytes", "Capacity in bytes.")
    ];
    private static readonly NotificationVariable[] Network =
    [
        new("network.reachability", "Current reachability."),
        new("network.previousReachability", "Last known reachability."),
        new("network.interface", "Primary network interface."),
        new("network.vpn", "Observed VPN state.")
    ];
    private static readonly NotificationVariable[] Battery =
    [
        new("battery.chargePercent", "Current battery level in percent."),
        new("battery.charging", "Whether macOS reports charging."),
        new("battery.externalPower", "Whether the device uses external power.")
    ];
    private static readonly NotificationVariable[] Metric =
    [
        new("metric.value", "Current sampled percentage."),
        new("metric.previousValue", "Previous sampled percentage."),
        new("metric.thresholdPercent", "Percentage configured on the matching rule.")
    ];
    private static readonly NotificationVariable[] Connection =
    [
        new("connection.id", "Agent connection UUID."),
        new("connection.protocol", "WSS or HTTPS transport identifier."),
        new("connection.lastSeenAt", "Last observed communication in ISO 8601 UTC.")
    ];

    internal static NotificationEventType Entry(string type, string description, NotificationVariable[]? variables = null,
        string[]? filters = null) => new(type, description, [.. Common, .. variables ?? []], filters ?? []);

    private static NotificationEventType App(string kind, string description) =>
        Entry($"application.{kind}", description, Application, ["bundleId", "applicationId"]);

    private static NotificationEventType Disk(string kind, string description) =>
        Entry($"storage.{kind}", description, Storage, ["storageId"]);

    public static readonly NotificationEventType[] Types =
    [
        Entry("device.online", "An approved Agent returned after an observed disconnection.", Connection),
        Entry("device.offline", "The server lost the approved Agent connection.", Connection),
        Entry("lid.closed", "The laptop lid changed to closed.", [new("lid.closed", "Boolean lid state.")]),
        Entry("lid.opened", "The laptop lid changed to open.", [new("lid.closed", "Boolean lid state.")]),
        Entry("system.sleeping", "macOS is preparing to sleep."),
        Entry("system.woke", "macOS resumed from system sleep."),
        Entry("system.locked", "The user session locked."),
        Entry("system.unlocked", "The user session unlocked."),
        Entry("display.slept", "The displays went to sleep."),
        Entry("display.woke", "The displays woke."),
        Entry("display.configurationChanged", "The display configuration changed.",
            [new("display.count", "Observed display count."), new("display.previousCount", "Previous display count.")]),
        App("launched", "A running application appeared."),
        App("terminated", "A running application exited."),
        App("activated", "An application was activated."),
        App("deactivated", "An application was deactivated."),
        App("hidden", "An application was hidden."),
        App("unhidden", "An application was unhidden."),
        App("installed", "An application appeared in the installed inventory."),
        App("removed", "An application disappeared from the installed inventory."),
        App("updated", "An application changed in the installed inventory."),
        Disk("inserted", "External storage appeared."),
        Disk("removed", "External storage disappeared."),
        Disk("mounted", "External storage was mounted."),
        Disk("unmounted", "External storage was unmounted."),
        Entry("network.changed", "Primary interface, VPN or reachability changed.", Network),
        Entry("network.reachable", "The Agent gained a reachable network path.", Network),
        Entry("network.unavailable", "The Agent lost its reachable network path.", Network),
        Entry("power.lowPowerEnabled", "macOS enabled Low Power Mode."),
        Entry("power.lowPowerDisabled", "macOS disabled Low Power Mode."),
        Entry("battery.externalConnected", "External power became available.", Battery),
        Entry("battery.externalDisconnected", "External power became unavailable.", Battery),
        Entry("battery.chargingStarted", "The battery began charging.", Battery),
        Entry("battery.chargingStopped", "The battery stopped charging.", Battery),
        Entry("battery.levelBelow", "Battery level moved below the configured threshold.", [.. Battery, .. Metric], ["thresholdPercent"]),
        Entry("battery.levelRecovered", "Battery level returned to or above the configured threshold.", [.. Battery, .. Metric], ["thresholdPercent"]),
        Entry("cpu.usageAbove", "Sampled CPU usage reached or exceeded the configured threshold.", Metric, ["thresholdPercent"]),
        Entry("cpu.usageBelow", "Sampled CPU usage moved below the configured threshold.", Metric, ["thresholdPercent"]),
        Entry("memory.usageAbove", "Sampled memory usage reached or exceeded the configured threshold.", Metric, ["thresholdPercent"]),
        Entry("memory.usageBelow", "Sampled memory usage moved below the configured threshold.", Metric, ["thresholdPercent"]),
        Entry("clipboard.changed", "The clipboard ownership count changed."),
        Entry("telemetry.gap", "The Agent reported lost buffered telemetry."),
        .. NotificationFileEvents.Catalogue()
    ];

    private static readonly Dictionary<string, NotificationEventType> ByType = Types.ToDictionary(x => x.Type, StringComparer.Ordinal);

    public static NotificationEventType Require(string? type) =>
        Find(type) ?? throw Fault.Bad("invalid_notification_event");

    public static NotificationEventType? Find(string? type) => type is null ? null : ByType.GetValueOrDefault(type);

    public static NotificationEventType[] RequireSelection(IReadOnlyList<string>? events)
    {
        if (events is not { Count: >= 1 and <= 16 } ||
            events.Distinct(StringComparer.Ordinal).Count() != events.Count)
            throw Fault.Bad("invalid_notification_events");
        return events.Select(Require).ToArray();
    }

    public static HashSet<string> Variables(IEnumerable<NotificationEventType> types) =>
        types.SelectMany(type => type.Variables.Select(variable => variable.Name)).ToHashSet(StringComparer.Ordinal);
}
