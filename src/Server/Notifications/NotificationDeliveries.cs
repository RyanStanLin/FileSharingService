using System.Globalization;
using System.Text;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed record NotificationDeliveryRow(long Sequence, string Id, string ChannelId, string ChannelName, string ChannelKind,
    long ChannelRevision, string? RuleId, long? RuleRevision, string? DeviceId, string? RootId, string Event, long? SourceSequence,
    long Occurred, string? Context, string Message, string? TestKey, string? TestFingerprint, string State, int Attempts, long Created, long Updated,
    long NextAttempt, string? Error, int? HttpStatus, string? ProviderId)
{
    public NotificationDeliveryRow() : this(0, "", "", "", "", 0, null, null, null, null, "", null, 0,
        null, "", null, null, "", 0, 0, 0, 0, null, null, null) { }

    public NotificationMessage Content => Wire.Model<NotificationMessage>(Wire.Parse(Message));
    public NotificationDeliveryView View => new(Id, Sequence.ToString(CultureInfo.InvariantCulture), ChannelId, ChannelName, ChannelKind,
        RuleId, DeviceId, RootId, Event, SourceSequence?.ToString(CultureInfo.InvariantCulture), Clock.At(Occurred),
        Context is null ? null : Wire.Model<Dictionary<string, string>>(Wire.Parse(Context)), Content, State, Attempts,
        Clock.At(Created), Clock.At(Updated), State is "queued" or "retryScheduled" ? Clock.At(NextAttempt) : null, Error, HttpStatus, ProviderId);
}

internal sealed record NotificationWork(string? RuleId, long? RuleRevision, string? DeviceId, string? RootId, string Event,
    long? SourceSequence, long Occurred, string? Context, NotificationMessage Message, string? TestKey = null, string? TestFingerprint = null);

internal interface INotificationDeliveries
{
    Task<NotificationDeliveryView> Test(string channelId, string? idempotencyKey, NotificationTestRequest request, string actor, CancellationToken ct);
    Task<NotificationDeliveryView> Get(string id, CancellationToken ct);
    Task<NotificationDeliveriesPage> List(string? after, int? limit, string? channelId, string? ruleId, string? deviceId, string? state,
        CancellationToken ct);
}

internal sealed class NotificationDeliveries(Database db, NotificationVault vault) : INotificationDeliveries
{
    public const int MaximumPending = 2000;
    public const int MaximumPerChannel = 500;
    public const int MaximumAttempts = 5;
    private const int RetentionDays = 30;
    private const int MaximumHistory = 50_000;
    private const int MaximumUpdates = 100_000;
    private const string Pending = "('queued','retryScheduled','sending')";

    public Task<NotificationDeliveryView> Test(string channelId, string? idempotencyKey, NotificationTestRequest request, string actor,
        CancellationToken ct)
    {
        if (idempotencyKey is null)
            throw new Fault(428, "idempotency_required");
        var key = Secrets.Text(idempotencyKey, 128);
        var message = new NotificationMessage(
            TestText(request.Title, "FileSharing", NotificationText.TitleBytes),
            TestText(request.Body, "Test notification", NotificationText.BodyBytes));
        var fingerprint = Secrets.Hash(Wire.Encode(message));
        return db.Write(async (connection, tx) =>
        {
            var channel = await NotificationChannels.Require(connection, tx, channelId, ct);
            var previous = await connection.QuerySingleOrDefaultAsync<NotificationDeliveryRow>(new CommandDefinition("""
                SELECT * FROM NotificationDeliveries WHERE ChannelId=@channelId AND TestKey=@key
                """, new { channelId, key }, tx, cancellationToken: ct));
            if (previous is not null)
            {
                if (previous.TestFingerprint != fingerprint)
                    throw Fault.Conflict("idempotency_conflict");
                return previous.View;
            }
            if (!channel.Enabled)
                throw Fault.Conflict("notification_channel_disabled");
            if (!vault.Enabled)
                throw Fault.Unavailable("notification_vault_unconfigured");
            _ = vault.Open(channel);
            if (!await HasCapacity(connection, tx, channelId, ct))
                throw new Fault(429, "notification_queue_limit");
            var row = await Enqueue(connection, tx, channel,
                new(null, null, null, null, "test", null, Clock.Now, null, message, key, fingerprint), ct);
            await NotificationStorage.Audit(connection, tx, actor, null, "notification.test_queued", new { channelId, row.Id }, ct);
            return row.View;
        });
    }

    public async Task<NotificationDeliveryView> Get(string id, CancellationToken ct) =>
        (await db.One<NotificationDeliveryRow>("SELECT * FROM NotificationDeliveries WHERE Id=@id", new { id = Secrets.Identifier(id) }, ct)
            ?? throw Fault.Missing("notification_delivery_not_found")).View;

    public async Task<NotificationDeliveriesPage> List(string? after, int? limit, string? channelId, string? ruleId, string? deviceId,
        string? state, CancellationToken ct)
    {
        if (state is not (null or "queued" or "sending" or "retryScheduled" or "sent" or "failed" or "cancelled"))
            throw Fault.Bad("invalid_notification_delivery_state");
        if (channelId is not null)
            Secrets.Identifier(channelId);
        if (ruleId is not null)
            Secrets.Identifier(ruleId);
        if (deviceId is not null)
            Secrets.Identifier(deviceId);
        var take = Page<NotificationDeliveryView>.Size(limit);
        var cursor = EventFeed.Cursor(after);
        var rows = await db.List<NotificationDeliveryRow>("""
            SELECT * FROM NotificationDeliveries
            WHERE Sequence>@cursor AND (@channelId IS NULL OR ChannelId=@channelId)
              AND (@ruleId IS NULL OR RuleId=@ruleId) AND (@deviceId IS NULL OR DeviceId=@deviceId)
              AND (@state IS NULL OR State=@state)
            ORDER BY Sequence LIMIT @size
            """, new { cursor, channelId, ruleId, deviceId, state, size = take + 1 }, ct);
        var items = rows.Take(take).Select(row => row.View).ToArray();
        return new(items, items.LastOrDefault()?.Sequence ?? cursor.ToString(CultureInfo.InvariantCulture), rows.Count > take);
    }

    internal static Task<bool> HasCapacity(SqliteConnection connection, SqliteTransaction tx, string channel, CancellationToken ct) =>
        connection.ExecuteScalarAsync<bool>(new CommandDefinition($"""
            SELECT (SELECT COUNT(*) FROM NotificationDeliveries WHERE State IN {Pending})<@MaximumPending
                AND (SELECT COUNT(*) FROM NotificationDeliveries WHERE State IN {Pending} AND ChannelId=@channel)<@MaximumPerChannel
            """, new { channel, MaximumPending, MaximumPerChannel }, tx, cancellationToken: ct));

    internal static async Task<NotificationDeliveryRow> Enqueue(SqliteConnection connection, SqliteTransaction tx,
        NotificationChannelRow channel, NotificationWork work, CancellationToken ct)
    {
        var now = Clock.Now;
        var row = await connection.QuerySingleAsync<NotificationDeliveryRow>(new CommandDefinition("""
            INSERT INTO NotificationDeliveries(Id,ChannelId,ChannelName,ChannelKind,ChannelRevision,RuleId,RuleRevision,
                DeviceId,RootId,Event,SourceSequence,Occurred,Context,Message,TestKey,TestFingerprint,State,Created,Updated,NextAttempt)
            VALUES(@id,@channel,@name,@kind,@revision,@RuleId,@RuleRevision,@DeviceId,@RootId,@Event,@SourceSequence,@Occurred,
                @Context,@message,@TestKey,@TestFingerprint,'queued',@now,@now,@now)
            RETURNING *
            """, new
        {
            id = Secrets.Id(), channel = channel.Id, name = channel.Name, kind = channel.Kind, revision = channel.Revision,
            work.RuleId, work.RuleRevision, work.DeviceId, work.RootId, work.Event, work.SourceSequence, work.Occurred,
            work.Context, message = Wire.Encode(work.Message), work.TestKey, work.TestFingerprint, now
        }, tx, cancellationToken: ct));
        await Record(connection, tx, row, ct);
        return row;
    }

    public async Task<IReadOnlyList<NotificationDeliveryRow>> Claim(int count, CancellationToken ct)
    {
        if (!await db.One<bool>("""
            SELECT EXISTS(SELECT 1 FROM NotificationDeliveries d LEFT JOIN NotificationChannels c ON c.Id=d.ChannelId
                WHERE d.State IN ('queued','retryScheduled') AND d.NextAttempt<=@now AND COALESCE(c.Available,0)<=@now)
            """, new { now = Clock.Now }, ct))
            return [];

        return await db.Write<IReadOnlyList<NotificationDeliveryRow>>(async (connection, tx) =>
        {
            var now = Clock.Now;
            var rows = (await connection.QueryAsync<NotificationDeliveryRow>(new CommandDefinition("""
                WITH candidates AS (
                    SELECT d.Sequence,d.NextAttempt,
                        ROW_NUMBER() OVER (PARTITION BY d.ChannelId ORDER BY d.NextAttempt,d.Sequence) AS position
                    FROM NotificationDeliveries d LEFT JOIN NotificationChannels c ON c.Id=d.ChannelId
                    WHERE d.State IN ('queued','retryScheduled') AND d.NextAttempt<=@now
                      AND (c.Id IS NULL OR c.Enabled=0 OR c.Revision<>d.ChannelRevision OR c.Available<=@now)
                      AND NOT EXISTS (SELECT 1 FROM NotificationDeliveries inFlight
                          WHERE inFlight.ChannelId=d.ChannelId AND inFlight.State='sending')
                )
                UPDATE NotificationDeliveries SET State='sending',Attempts=Attempts+1,Updated=@now,Error=NULL,HttpStatus=NULL
                WHERE Sequence IN (SELECT Sequence FROM candidates WHERE position=1 ORDER BY NextAttempt,Sequence LIMIT @count)
                RETURNING *
                """, new { now, count }, tx, cancellationToken: ct))).AsList();
            foreach (var row in rows)
                await Record(connection, tx, row, ct);
            return rows;
        });
    }

    internal static async Task CancelPending(SqliteConnection connection, SqliteTransaction tx, string? channelId,
        string? ruleId, string code, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<NotificationDeliveryRow>(new CommandDefinition("""
            UPDATE NotificationDeliveries SET State='cancelled',Updated=@now,Error=@code
            WHERE State IN ('queued','retryScheduled') AND (ChannelId=@channelId OR RuleId=@ruleId)
            RETURNING *
            """, new { now = Clock.Now, channelId, ruleId, code }, tx, cancellationToken: ct));
        foreach (var row in rows)
            await Record(connection, tx, row, ct);
    }

    public Task<NotificationChannelRow?> Destination(NotificationDeliveryRow row, CancellationToken ct) =>
        db.One<NotificationChannelRow>("""
            SELECT c.* FROM NotificationChannels c
            WHERE c.Id=@ChannelId AND c.Enabled=1 AND c.Revision=@ChannelRevision AND (@RuleId IS NULL OR EXISTS(
                SELECT 1 FROM NotificationRules r JOIN Devices d ON d.Id=r.DeviceId AND d.Revoked IS NULL
                WHERE r.Id=@RuleId AND r.Enabled=1 AND r.Revision=@RuleRevision AND r.DeviceId=@DeviceId))
            AND (@RootId IS NULL OR EXISTS(SELECT 1 FROM Roots WHERE Id=@RootId AND DeviceId=@DeviceId AND Enabled=1))
            """, row, ct);

    public Task Complete(NotificationDeliveryRow row, NotificationProviderResult outcome, bool cancelled, CancellationToken ct) =>
        db.Write(async (connection, tx) =>
        {
            var now = Clock.Now;
            var state = cancelled ? "cancelled" : outcome.Error is null ? "sent" :
                outcome.Transient && row.Attempts < MaximumAttempts ? "retryScheduled" : "failed";
            var next = state == "retryScheduled" ? now + Math.Max(5 << (2 * (row.Attempts - 1)), outcome.RetrySeconds) : now;
            var updated = await connection.QuerySingleOrDefaultAsync<NotificationDeliveryRow>(new CommandDefinition("""
                UPDATE NotificationDeliveries SET State=@state,Updated=@now,NextAttempt=@next,Error=@Error,
                    HttpStatus=@HttpStatus,ProviderId=@ProviderId,Attempts=Attempts-@unattempted
                WHERE Sequence=@Sequence AND State='sending' AND Attempts=@Attempts RETURNING *
                """, new { state, now, next, outcome.Error, outcome.HttpStatus, outcome.ProviderId,
                    unattempted = cancelled ? 1 : 0, row.Sequence, row.Attempts }, tx, cancellationToken: ct));
            if (updated is null)
                return false;
            if (!cancelled && outcome.RetrySeconds > 0)
                await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE NotificationChannels SET Available=MAX(Available,@available) WHERE Id=@ChannelId AND Revision=@ChannelRevision
                    """, new { available = outcome.RetrySeconds + now, row.ChannelId, row.ChannelRevision }, tx, cancellationToken: ct));
            await Record(connection, tx, updated, ct);
            return true;
        });

    public Task Recover(CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var now = Clock.Now;
        var rows = await connection.QueryAsync<NotificationDeliveryRow>(new CommandDefinition("""
            UPDATE NotificationDeliveries SET State=CASE WHEN Attempts<@MaximumAttempts THEN 'retryScheduled' ELSE 'failed' END,
                Updated=@now, NextAttempt=@now, Error='notification_delivery_interrupted' WHERE State='sending' RETURNING *
            """, new { now, MaximumAttempts }, tx, cancellationToken: ct));
        foreach (var row in rows)
            await Record(connection, tx, row, ct);
        return true;
    });

    public Task Clean(CancellationToken ct) => db.Execute($"""
        DELETE FROM NotificationDeliveries WHERE State NOT IN {Pending} AND (Updated<@cutoff OR
            Sequence <= (SELECT seq-@MaximumHistory FROM sqlite_sequence WHERE name='NotificationDeliveries'));
        DELETE FROM NotificationUpdates WHERE At<@cutoff OR
            Sequence <= (SELECT seq-@MaximumUpdates FROM sqlite_sequence WHERE name='NotificationUpdates');
        """, new { cutoff = Clock.Now - RetentionDays * 86400, MaximumHistory, MaximumUpdates }, ct);

    private static Task Record(SqliteConnection connection, SqliteTransaction tx, NotificationDeliveryRow row, CancellationToken ct) =>
        NotificationUpdates.Record(connection, tx, row.DeviceId,
            new("delivery", row.Id, row.State == "queued" ? "created" : "updated", State: row.State, ChannelId: row.ChannelId, RuleId: row.RuleId), ct);

    private static string TestText(string? input, string fallback, int maximum)
    {
        if (input is null)
            return fallback;
        if (string.IsNullOrWhiteSpace(input) || input.Length > maximum || Encoding.UTF8.GetByteCount(input) > maximum ||
            NotificationText.HasUnsupportedControls(input))
            throw Fault.Bad("invalid_notification_test_message");
        return input;
    }
}
