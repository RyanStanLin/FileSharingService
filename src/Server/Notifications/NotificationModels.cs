using System.Text.Json;
using System.Text.Json.Serialization;

namespace FileSharing;

/// <summary>A notification destination. Credentials are accepted only on write.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationChannelRequest(string Name, string Kind, bool Enabled, long? Revision,
    BarkChannelRequest? Bark, TelegramChannelRequest? Telegram);

/// <summary>Bark delivery settings and an optional replacement device key.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record BarkChannelRequest(string? Server, string? DeviceKey, string? Group, string? Sound, string? Level);

/// <summary>A Telegram Bot API destination and an optional replacement bot token.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record TelegramChannelRequest(string ChatId, string? BotToken, int? MessageThreadId, bool Silent);

/// <summary>The public settings of a Bark destination.</summary>
internal sealed record BarkChannelSettings(string Server, string? Group, string? Sound, string? Level);

/// <summary>The public settings of a Telegram destination.</summary>
internal sealed record TelegramChannelSettings(string ChatId, int? MessageThreadId, bool Silent);

/// <summary>A saved notification destination with redacted credentials.</summary>
internal sealed record NotificationChannelView(string Id, string Name, string Kind, bool Enabled, long Revision,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, bool CredentialConfigured, BarkChannelSettings? Bark,
    TelegramChannelSettings? Telegram);

/// <summary>The verified identity of a Telegram bot and its target chat.</summary>
internal sealed record TelegramVerification(string BotId, string? BotUsername, string ChatId, string ChatType);

/// <summary>An explicit test notification sent through a saved destination.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationTestRequest(string? Title, string? Body);

/// <summary>Plain-text notification content before provider-specific formatting.</summary>
internal sealed record NotificationMessage(string Title, string Body);

/// <summary>A delivery and its latest observed provider result.</summary>
internal sealed record NotificationDeliveryView(string Id, string Sequence, string ChannelId, string ChannelName, string ChannelKind,
    string? RuleId, string? DeviceId, string? RootId, string Event, string? SourceSequence, DateTimeOffset OccurredAt,
    IReadOnlyDictionary<string, string>? Context, NotificationMessage Message, string State, int Attempts,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? NextAttemptAt, string? Error, int? HttpStatus, string? ProviderId);

/// <summary>A forward-only page of notification deliveries.</summary>
internal sealed record NotificationDeliveriesPage(IReadOnlyList<NotificationDeliveryView> Items, string Cursor, bool HasMore);

/// <summary>A safe change summary for replay and WebSocket subscriptions.</summary>
internal sealed record NotificationUpdate(string Resource, string Id, string Action, long? Revision = null,
    string? State = null, string? ChannelId = null, string? RuleId = null);

internal sealed record NotificationChannelRow(string Id, string Name, string Kind, bool Enabled, long Revision,
    long Created, long Updated, string Config, string SecretCipher, long Available = 0)
{
    public NotificationChannelRow() : this("", "", "", false, 0, 0, 0, "", "") { }

    public BarkChannelSettings Bark => Wire.Model<BarkChannelSettings>(Wire.Parse(Config));
    public TelegramChannelSettings Telegram => Wire.Model<TelegramChannelSettings>(Wire.Parse(Config));

    public NotificationChannelView View => new(Id, Name, Kind, Enabled, Revision, Clock.At(Created), Clock.At(Updated),
        true, Kind == "bark" ? Bark : null, Kind == "telegram" ? Telegram : null);
}
