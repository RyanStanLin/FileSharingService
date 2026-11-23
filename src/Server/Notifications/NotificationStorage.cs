using Dapper;

namespace FileSharing;

internal static class NotificationStorage
{
    public const string Migration = """
        CREATE TABLE NotificationChannels(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            Kind TEXT NOT NULL CHECK(Kind IN ('bark','telegram')),
            Enabled INTEGER NOT NULL, Revision INTEGER NOT NULL,
            Created INTEGER NOT NULL, Updated INTEGER NOT NULL,
            Config TEXT NOT NULL, SecretCipher TEXT NOT NULL, Available INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE NotificationDeliveries(
            Sequence INTEGER PRIMARY KEY AUTOINCREMENT, Id TEXT NOT NULL UNIQUE,
            ChannelId TEXT NOT NULL, ChannelName TEXT NOT NULL, ChannelKind TEXT NOT NULL, ChannelRevision INTEGER NOT NULL,
            RuleId TEXT, RuleRevision INTEGER, DeviceId TEXT, RootId TEXT, Event TEXT NOT NULL, SourceSequence INTEGER,
            Occurred INTEGER NOT NULL, Context TEXT, Message TEXT NOT NULL,
            TestKey TEXT, TestFingerprint TEXT,
            State TEXT NOT NULL CHECK(State IN ('queued','sending','retryScheduled','sent','failed','cancelled')),
            Attempts INTEGER NOT NULL DEFAULT 0, Created INTEGER NOT NULL, Updated INTEGER NOT NULL, NextAttempt INTEGER NOT NULL,
            Error TEXT, HttpStatus INTEGER, ProviderId TEXT,
            UNIQUE(ChannelId, TestKey));
        CREATE INDEX NotificationDeliveriesDue ON NotificationDeliveries(NextAttempt,Sequence)
            WHERE State IN ('queued','retryScheduled');
        CREATE INDEX NotificationDeliveriesActiveChannel ON NotificationDeliveries(ChannelId,State)
            WHERE State IN ('queued','sending','retryScheduled');
        CREATE INDEX NotificationDeliveriesByChannel ON NotificationDeliveries(ChannelId,Sequence);
        CREATE INDEX NotificationDeliveriesByRule ON NotificationDeliveries(RuleId,Sequence);
        CREATE INDEX NotificationDeliveriesUpdated ON NotificationDeliveries(Updated);
        CREATE TABLE NotificationUpdates(
            Sequence INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId TEXT, At INTEGER NOT NULL, Payload TEXT NOT NULL);
        CREATE INDEX NotificationUpdatesByTime ON NotificationUpdates(At);
        """;

    public static Task Audit(Microsoft.Data.Sqlite.SqliteConnection connection, Microsoft.Data.Sqlite.SqliteTransaction tx,
        string actor, string? device, string action, object detail, CancellationToken ct) =>
        connection.ExecuteAsync(new Dapper.CommandDefinition("""
            INSERT INTO Audit(At,Actor,DeviceId,Action,Detail) VALUES(@at,@actor,@device,@action,@json)
            """, new { at = Clock.Now, actor, device, action, json = Wire.Encode(detail) }, tx, cancellationToken: ct));
}
