using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed record NotificationRuleRow(string Id, string Name, string DeviceId, bool Enabled, long Revision, long Created, long Updated,
    string Events, string ChannelIds, string Template, string Filter, int CooldownSeconds,
    long MatchedEvents = 0, long EnqueuedDeliveries = 0, long SkippedDeliveries = 0, long? LastMatched = null)
{
    public NotificationRuleRow() : this("", "", "", false, 0, 0, 0, "", "", "", "", 0) { }

    public string[] EventTypes => Wire.Model<string[]>(Wire.Parse(Events));
    public string[] Channels => Wire.Model<string[]>(Wire.Parse(ChannelIds));
    public NotificationTemplate Content => Wire.Model<NotificationTemplate>(Wire.Parse(Template));
    public NotificationFilter Conditions => Wire.Model<NotificationFilter>(Wire.Parse(Filter));

    public NotificationRuleView View => new(Id, Name, DeviceId, Enabled, Revision, EventTypes, Channels, Content, Conditions, CooldownSeconds,
        Clock.At(Created), Clock.At(Updated), MatchedEvents, EnqueuedDeliveries, SkippedDeliveries,
        LastMatched is { } at ? Clock.At(at) : null);
}

internal interface INotificationRules
{
    Task<Page<NotificationRuleView>> List(string? cursor, int? limit, string? deviceId, bool? enabled, CancellationToken ct);
    Task<NotificationRuleView> Get(string id, CancellationToken ct);
    Task<NotificationRuleView> Save(string? id, NotificationRuleRequest request, string actor, CancellationToken ct);
    Task Delete(string id, long? revision, string actor, CancellationToken ct);
}

internal sealed class NotificationRules(Database db) : INotificationRules
{
    public const int Maximum = 128;
    public const int MaximumPerDevice = 32;
    public const int MaximumChannels = 8;
    private const int MaximumEvents = 16;

    public async Task<Page<NotificationRuleView>> List(string? cursor, int? limit, string? deviceId, bool? enabled, CancellationToken ct)
    {
        var take = Page<NotificationRuleView>.Size(limit);
        if (deviceId is not null)
            Secrets.Identifier(deviceId);
        var rows = await db.List<NotificationRuleRow>("""
            SELECT * FROM NotificationRules WHERE Id>@after AND (@deviceId IS NULL OR DeviceId=@deviceId)
                AND (@enabled IS NULL OR Enabled=@enabled) ORDER BY Id LIMIT @size
            """, new { after = Page<NotificationRuleView>.After(cursor), deviceId, enabled, size = take + 1 }, ct);
        return Page<NotificationRuleView>.From(rows.Select(x => x.View).ToArray(), take, x => x.Id);
    }

    public async Task<NotificationRuleView> Get(string id, CancellationToken ct) =>
        (await db.One<NotificationRuleRow>("SELECT * FROM NotificationRules WHERE Id=@id", new { id = Secrets.Identifier(id) }, ct)
            ?? throw Fault.Missing("notification_rule_not_found")).View;

    public Task<NotificationRuleView> Save(string? id, NotificationRuleRequest request, string actor, CancellationToken ct)
    {
        var input = Validate(request);
        return db.Write(async (connection, tx) =>
        {
            var current = id is null ? null : await Require(connection, tx, id, ct);
            if (current is null && request.Revision is not null)
                throw Fault.Bad("revision_not_allowed");
            if (current is not null)
                NotificationChannels.RequireRevision(request.Revision, current.Revision);

            var device = request.DeviceId;
            if (!await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
                SELECT EXISTS(SELECT 1 FROM Devices WHERE Id=@device AND Revoked IS NULL)
                """, new { device }, tx, cancellationToken: ct)))
                throw Fault.Missing("device_not_found");
            var foundChannels = await connection.ExecuteScalarAsync<int>(new CommandDefinition("""
                SELECT COUNT(*) FROM NotificationChannels WHERE Id IN (SELECT value FROM json_each(@channels))
                """, new { channels = Wire.Encode(request.ChannelIds) }, tx, cancellationToken: ct));
            if (foundChannels != request.ChannelIds.Count)
                throw Fault.Missing("notification_channel_not_found");

            if (current is null || current.DeviceId != device)
            {
                var available = await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
                    SELECT (@creating=0 OR (SELECT COUNT(*) FROM NotificationRules)<@Maximum)
                        AND (SELECT COUNT(*) FROM NotificationRules WHERE DeviceId=@device)<@MaximumPerDevice
                    """, new { creating = current is null, Maximum, MaximumPerDevice, device }, tx, cancellationToken: ct));
                if (!available)
                    throw new Fault(429, "notification_rule_limit");
            }

            if (input.Filter.File is { } file)
                await ValidateWatch(connection, tx, id, device, file, request.Enabled, ct);

            var now = Clock.Now;
            var row = new NotificationRuleRow(id ?? Secrets.Id(), input.Name, device, request.Enabled,
                (current?.Revision ?? 0) + 1, current?.Created ?? now, now, Wire.Encode(request.Events), Wire.Encode(request.ChannelIds),
                Wire.Encode(request.Template), Wire.Encode(input.Filter), input.Cooldown, current?.MatchedEvents ?? 0,
                current?.EnqueuedDeliveries ?? 0, current?.SkippedDeliveries ?? 0, current?.LastMatched);
            await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO NotificationRules(Id,Name,DeviceId,Enabled,Revision,Created,Updated,Events,ChannelIds,Template,Filter,CooldownSeconds)
                VALUES(@Id,@Name,@DeviceId,@Enabled,@Revision,@Created,@Updated,@Events,@ChannelIds,@Template,@Filter,@CooldownSeconds)
                ON CONFLICT(Id) DO UPDATE SET Name=excluded.Name,DeviceId=excluded.DeviceId,Enabled=excluded.Enabled,Revision=excluded.Revision,
                    Updated=excluded.Updated,Events=excluded.Events,ChannelIds=excluded.ChannelIds,Template=excluded.Template,
                    Filter=excluded.Filter,CooldownSeconds=excluded.CooldownSeconds;
                DELETE FROM NotificationCooldowns WHERE RuleId=@Id;
                """, new { row.Id, row.Name, row.DeviceId, row.Enabled, row.Revision, row.Created, row.Updated, row.Events, row.ChannelIds,
                    row.Template, row.Filter, row.CooldownSeconds }, tx, cancellationToken: ct));
            if (current is not null)
                await NotificationDeliveries.CancelPending(connection, tx, null, row.Id, "notification_rule_changed", ct);
            await RecordChange(connection, tx, row, current is null ? "created" : "updated", actor, ct);
            return row.View;
        });
    }

    public Task Delete(string id, long? revision, string actor, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var existing = await Require(connection, tx, id, ct);
        NotificationChannels.RequireRevision(revision, existing.Revision);
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM NotificationRules WHERE Id=@id", new { id }, tx, cancellationToken: ct));
        await NotificationDeliveries.CancelPending(connection, tx, null, id, "notification_rule_changed", ct);
        await RecordChange(connection, tx, existing, "deleted", actor, ct);
        return true;
    });

    private static async Task ValidateWatch(SqliteConnection connection, SqliteTransaction tx, string? id, string device,
        NotificationFileFilter file, bool enabled, CancellationToken ct)
    {
        if (!enabled && id is not null)
            return;
        var scope = new { id, device, file.RootId, file.Path, limit = NotificationFileWatches.MaximumPerDevice };
        if (!await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
            SELECT EXISTS(SELECT 1 FROM Roots WHERE DeviceId=@device AND Id=@RootId AND Enabled=1)
            """, scope, tx, cancellationToken: ct)))
            throw Fault.Forbidden("root_access_denied");
        if (!enabled)
            return;
        var available = await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
            WITH targets AS (
                SELECT DISTINCT json_extract(Filter,'$.file.rootId') AS RootId, json_extract(Filter,'$.file.path') AS Path
                FROM NotificationRules WHERE DeviceId=@device AND Enabled=1 AND Id<>COALESCE(@id,'')
                    AND json_type(Filter,'$.file')='object'
            )
            SELECT (SELECT COUNT(*) FROM targets)<@limit OR EXISTS(SELECT 1 FROM targets WHERE RootId=@RootId AND Path=@Path)
            """, scope, tx, cancellationToken: ct));
        if (!available)
            throw new Fault(429, "notification_watch_limit");
    }

    private static async Task<NotificationRuleRow> Require(SqliteConnection connection, SqliteTransaction tx, string id, CancellationToken ct) =>
        await connection.QuerySingleOrDefaultAsync<NotificationRuleRow>(new CommandDefinition("SELECT * FROM NotificationRules WHERE Id=@id",
            new { id = Secrets.Identifier(id) }, tx, cancellationToken: ct)) ?? throw Fault.Missing("notification_rule_not_found");

    private static async Task RecordChange(SqliteConnection connection, SqliteTransaction tx, NotificationRuleRow row, string action,
        string actor, CancellationToken ct)
    {
        await NotificationStorage.Audit(connection, tx, actor, row.DeviceId, $"notification.rule_{action}",
            new { row.Id, row.Enabled, row.Revision }, ct);
        await NotificationUpdates.Record(connection, tx, row.DeviceId, new("rule", row.Id, action, row.Revision), ct);
    }

    private static (string Name, NotificationFilter Filter, int Cooldown) Validate(NotificationRuleRequest request)
    {
        var name = Secrets.Text(request.Name);
        Secrets.Identifier(request.DeviceId);
        if (request.Events is not { Count: >= 1 and <= MaximumEvents } ||
            request.Events.Distinct(StringComparer.Ordinal).Count() != request.Events.Count)
            throw Fault.Bad("invalid_notification_events");
        var types = request.Events.Select(NotificationCatalog.Require).ToArray();
        if (request.ChannelIds is not { Count: >= 1 and <= MaximumChannels } ||
            request.ChannelIds.Distinct(StringComparer.Ordinal).Count() != request.ChannelIds.Count)
            throw Fault.Bad("invalid_notification_channels");
        foreach (var channel in request.ChannelIds)
            Secrets.Identifier(channel);
        var filter = request.Filter ?? new NotificationFilter(null, null, null, null);
        var fields = types.SelectMany(type => type.Filters).ToHashSet(StringComparer.Ordinal);
        if (filter.BundleId is not null && !fields.Contains("bundleId") ||
            filter.ApplicationId is not null && !fields.Contains("applicationId") ||
            filter.StorageId is not null && !fields.Contains("storageId") ||
            fields.Contains("thresholdPercent") != (filter.ThresholdPercent is not null) ||
            filter.ThresholdPercent is < 1 or > 100)
            throw Fault.Bad("invalid_notification_filter");
        filter = filter with
        {
            BundleId = filter.BundleId is { } bundleId ? Secrets.Text(bundleId, 255) : null,
            ApplicationId = filter.ApplicationId is { } appId ? Secrets.Text(appId, 256) : null,
            StorageId = filter.StorageId is { } storageId ? Secrets.Text(storageId, 120) : null,
            File = NotificationFileEvents.Validate(filter.File, fields.Contains("file"))
        };
        var cooldown = request.CooldownSeconds ?? 0;
        if (cooldown is < 0 or > 86400)
            throw Fault.Bad("invalid_notification_cooldown");
        NotificationTemplates.Validate(request.Template, NotificationCatalog.Variables(types));
        return (name, filter, cooldown);
    }
}
