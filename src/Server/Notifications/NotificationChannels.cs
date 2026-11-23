using System.Globalization;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal interface INotificationChannels
{
    Task<Page<NotificationChannelView>> List(string? cursor, int? limit, CancellationToken ct);
    Task<NotificationChannelView> Get(string id, CancellationToken ct);
    Task<NotificationChannelView> Save(string? id, NotificationChannelRequest request, string actor, CancellationToken ct);
    Task Delete(string id, long? revision, string actor, CancellationToken ct);
    Task<TelegramVerification> Verify(string id, CancellationToken ct);
}

internal sealed class NotificationChannels(Database db, NotificationOptions options, NotificationVault vault,
    NotificationProviders providers) : INotificationChannels
{
    public const int Maximum = 64;

    public async Task<Page<NotificationChannelView>> List(string? cursor, int? limit, CancellationToken ct)
    {
        var take = Page<NotificationChannelView>.Size(limit);
        var rows = await db.List<NotificationChannelRow>("""
            SELECT * FROM NotificationChannels WHERE Id>@after ORDER BY Id LIMIT @size
            """, new { after = Page<NotificationChannelView>.After(cursor), size = take + 1 }, ct);
        return Page<NotificationChannelView>.From(rows.Select(x => x.View).ToArray(), take, x => x.Id);
    }

    public async Task<NotificationChannelView> Get(string id, CancellationToken ct) =>
        (await Find(id, ct)).View;

    public Task<NotificationChannelView> Save(string? id, NotificationChannelRequest request, string actor, CancellationToken ct)
    {
        var name = Secrets.Text(request.Name);
        var input = Validate(request);
        return db.Write(async (connection, tx) =>
        {
            var now = Clock.Now;
            var current = id is null ? null : await Require(connection, tx, id, ct);
            if (current is null && request.Revision is not null)
                throw Fault.Bad("revision_not_allowed");
            if (current is not null)
            {
                RequireRevision(request.Revision, current.Revision);
                if (current.Kind != request.Kind)
                    throw Fault.Bad("notification_channel_kind_immutable");
                if (input.BarkOrigin is { } origin && current.Bark.Server != origin && input.Credential is null)
                    throw Fault.Bad("bark_key_required_for_origin_change");
            }
            else if (await connection.ExecuteScalarAsync<int>(new CommandDefinition(
                "SELECT COUNT(*) FROM NotificationChannels", transaction: tx, cancellationToken: ct)) >= Maximum)
                throw new Fault(429, "notification_channel_limit");

            var channel = id ?? Secrets.Id();
            if (await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
                SELECT EXISTS(SELECT 1 FROM NotificationChannels WHERE Name=@name COLLATE NOCASE AND Id<>@channel)
                """, new { name, channel }, tx, cancellationToken: ct)))
                throw Fault.Conflict("notification_channel_name_in_use");

            var encrypted = input.Credential is { } credential ? vault.Seal(channel, request.Kind, credential) :
                current?.SecretCipher ?? throw Fault.Bad("notification_credential_required");
            var row = new NotificationChannelRow(channel, name, request.Kind, request.Enabled,
                (current?.Revision ?? 0) + 1, current?.Created ?? now, now, input.Config, encrypted);
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO NotificationChannels(Id,Name,Kind,Enabled,Revision,Created,Updated,Config,SecretCipher)
                VALUES(@Id,@Name,@Kind,@Enabled,@Revision,@Created,@Updated,@Config,@SecretCipher)
                ON CONFLICT(Id) DO UPDATE SET Name=excluded.Name,Enabled=excluded.Enabled,Revision=excluded.Revision,
                    Updated=excluded.Updated,Config=excluded.Config,SecretCipher=excluded.SecretCipher,Available=0
                """, row, tx, cancellationToken: ct));
            if (current is not null)
                await NotificationDeliveries.CancelPending(connection, tx, channel, null, "notification_destination_changed", ct);
            var action = current is null ? "created" : "updated";
            await NotificationStorage.Audit(connection, tx, actor, null, $"notification.channel_{action}",
                new { row.Id, row.Kind, row.Enabled, row.Revision }, ct);
            await NotificationUpdates.Record(connection, tx, null, new("channel", channel, action, row.Revision), ct);
            return row.View;
        });
    }

    public Task Delete(string id, long? revision, string actor, CancellationToken ct) =>
        db.Write(async (connection, tx) =>
        {
            var row = await Require(connection, tx, id, ct);
            RequireRevision(revision, row.Revision);
            await connection.ExecuteAsync(new CommandDefinition("DELETE FROM NotificationChannels WHERE Id=@id", new { id }, tx,
                cancellationToken: ct));
            await NotificationDeliveries.CancelPending(connection, tx, id, null, "notification_destination_changed", ct);
            await NotificationStorage.Audit(connection, tx, actor, null, "notification.channel_deleted", new { id, row.Kind }, ct);
            await NotificationUpdates.Record(connection, tx, null, new("channel", id, "deleted", row.Revision), ct);
            return true;
        });

    public async Task<TelegramVerification> Verify(string id, CancellationToken ct)
    {
        var row = await Find(id, ct);
        if (row.Kind != "telegram")
            throw Fault.Bad("notification_verification_requires_telegram");
        return await providers.VerifyTelegram(row, ct);
    }

    private async Task<NotificationChannelRow> Find(string id, CancellationToken ct) =>
        await db.One<NotificationChannelRow>("SELECT * FROM NotificationChannels WHERE Id=@id", new { id = Secrets.Identifier(id) }, ct)
        ?? throw Fault.Missing("notification_channel_not_found");

    internal static async Task<NotificationChannelRow> Require(SqliteConnection connection, SqliteTransaction tx, string id, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<NotificationChannelRow>(new CommandDefinition("""
            SELECT * FROM NotificationChannels WHERE Id=@id
            """, new { id = Secrets.Identifier(id) }, tx, cancellationToken: ct)) ?? throw Fault.Missing("notification_channel_not_found");

    internal static void RequireRevision(long? supplied, long actual)
    {
        if (supplied is null or <= 0)
            throw new Fault(428, "revision_required");
        if (supplied != actual)
            throw Fault.Conflict("revision_conflict");
    }

    private (string Config, string? Credential, string? BarkOrigin) Validate(NotificationChannelRequest request)
    {
        if (request is { Kind: "bark", Bark: { } bark, Telegram: null })
        {
            var origin = options.BarkOrigin(bark.Server);
            if (bark.DeviceKey is { } key && (key.Length is < 1 or > 128 || !key.All(IdentifierCharacter)))
                throw Fault.Bad("invalid_bark_key");
            if (bark.Level is not (null or "active" or "timeSensitive" or "passive" or "critical"))
                throw Fault.Bad("invalid_bark_level");
            var group = bark.Group is null ? null : Secrets.Text(bark.Group, 80);
            var sound = bark.Sound is null ? null : Secrets.Text(bark.Sound, 40);
            return (Wire.Encode(new BarkChannelSettings(origin, group, sound, bark.Level)), bark.DeviceKey, origin);
        }
        if (request is { Kind: "telegram", Bark: null, Telegram: { } telegram })
        {
            var chat = ChatId(telegram.ChatId);
            if (telegram.BotToken is { } token && !ValidBotToken(token))
                throw Fault.Bad("invalid_telegram_bot_token");
            if (telegram.MessageThreadId is <= 0)
                throw Fault.Bad("invalid_telegram_thread");
            return (Wire.Encode(new TelegramChannelSettings(chat, telegram.MessageThreadId, telegram.Silent)),
                telegram.BotToken, null);
        }
        throw Fault.Bad("invalid_notification_channel");
    }

    private static string ChatId(string? value)
    {
        if (value is { Length: >= 2 and <= 65 } && value[0] == '@' && value.AsSpan(1).ToString().All(IdentifierCharacter))
            return value;
        if (value is { Length: <= 20 } && long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var id) &&
            id is > -(1L << 52) and < (1L << 52) and not 0 &&
            value == id.ToString(CultureInfo.InvariantCulture))
            return value;
        throw Fault.Bad("invalid_telegram_chat");
    }

    private static bool ValidBotToken(string token)
    {
        var separator = token.IndexOf(':');
        return token.Length is >= 12 and <= 149 && separator is >= 1 and <= 20 &&
            token[..separator].All(char.IsAsciiDigit) &&
            token.Length - separator - 1 >= 10 && token[(separator + 1)..].All(IdentifierCharacter);
    }

    private static bool IdentifierCharacter(char c) => char.IsAsciiLetterOrDigit(c) || c is '_' or '-';
}
