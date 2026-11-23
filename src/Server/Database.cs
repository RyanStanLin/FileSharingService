using System.Text.Json;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed class Database(Settings settings)
{
    public SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(settings.DataDirectory, "filesharing.db"),
            ForeignKeys = true,
            DefaultTimeout = 5
        }.ToString());
        connection.Open();
        return connection;
    }

    public void Initialize()
    {
        Directory.CreateDirectory(settings.DataDirectory);
        using var connection = Open();
        connection.Execute("PRAGMA journal_mode=WAL");
        connection.Execute("PRAGMA foreign_keys=OFF");
        using var transaction = connection.BeginTransaction(deferred: false);
        var version = connection.ExecuteScalar<int>("PRAGMA user_version", transaction: transaction);
        switch (version)
        {
            case 0:
                connection.Execute(Schema, transaction: transaction);
                break;
            case 1:
                connection.Execute(MigrateOpenEnrollment, transaction: transaction);
                break;
            case 2:
            case 3:
            case 4:
            case 5:
            case 6:
            case 7:
                break;
            default:
                throw new InvalidOperationException($"Unsupported database version {version}");
        }
        if (version < 3)
            connection.Execute(MigrateJobOutput, transaction: transaction);
        if (version < 4)
            connection.Execute(MigrateGateways, transaction: transaction);
        if (version < 5)
            connection.Execute(NotificationStorage.Migration, transaction: transaction);
        if (version < 6)
            connection.Execute(NotificationStorage.RulesMigration, transaction: transaction);
        if (version < 7)
            connection.Execute(InteractionRecords.Migration, transaction: transaction);
        connection.Execute("UPDATE NotificationDevices SET ConnectionId=NULL WHERE ConnectionId IS NOT NULL", transaction: transaction);
        if (connection.Query("PRAGMA foreign_key_check", transaction: transaction).Any())
            throw new InvalidOperationException("Database foreign key check failed.");
        connection.Execute("PRAGMA user_version=7", transaction: transaction);
        transaction.Commit();
        connection.Execute("PRAGMA foreign_keys=ON");
    }

    public Task<T?> One<T>(string sql, object? parameters, CancellationToken cancellationToken) =>
        Use(connection => connection.QuerySingleOrDefaultAsync<T>(new(sql, parameters, cancellationToken: cancellationToken)));

    public Task<IReadOnlyList<T>> List<T>(string sql, object? parameters, CancellationToken cancellationToken) =>
        Use<IReadOnlyList<T>>(async connection => (await connection.QueryAsync<T>(new(sql, parameters, cancellationToken: cancellationToken))).AsList());

    public Task<int> Execute(string sql, object? parameters, CancellationToken cancellationToken) =>
        Use(connection => connection.ExecuteAsync(new(sql, parameters, cancellationToken: cancellationToken)));

    public async Task<T> Use<T>(Func<SqliteConnection, Task<T>> query)
    {
        await using var connection = Open();
        return await query(connection);
    }

    public async Task<T> Write<T>(Func<SqliteConnection, SqliteTransaction, Task<T>> action)
    {
        await using var connection = Open();
        await using var transaction = connection.BeginTransaction(deferred: false);
        var result = await action(connection, transaction);
        await transaction.CommitAsync(CancellationToken.None);
        return result;
    }

    public Task<bool> Mutate(string sql, object parameters, string? actor, string? device, string action,
        object detail, CancellationToken ct, Func<SqliteConnection, SqliteTransaction, CancellationToken, Task>? onChanged = null) =>
        Write(async (connection, tx) =>
    {
        var affected = await connection.ExecuteAsync(new CommandDefinition(sql, parameters, tx, cancellationToken: ct));
        if (affected == 0)
            return false;
        if (onChanged is not null)
            await onChanged(connection, tx, ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "INSERT INTO Audit(At,Actor,DeviceId,Action,Detail) VALUES(@At,@Actor,@Device,@Action,@Detail)",
            new { At = Clock.Now, Actor = actor, Device = device, Action = action, Detail = Wire.Encode(detail) }, tx, cancellationToken: ct));
        return true;
    });

    public Task Audit(string action, string? actor, string? device, object detail, CancellationToken cancellationToken) =>
        Execute("INSERT INTO Audit(At,Actor,DeviceId,Action,Detail) VALUES(@At,@Actor,@Device,@Action,@Detail)",
            new { At = Clock.Now, Actor = actor, Device = device, Action = action, Detail = Wire.Encode(detail) }, cancellationToken);

    public Task AppendEvent(string device, string topic, JsonElement value, CancellationToken cancellationToken) =>
        Execute("INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@device,@topic,@at,@payload)",
            new { device, topic, at = Clock.Now, payload = value.GetRawText() }, cancellationToken);

    private const string MigrateOpenEnrollment = """
        DROP TABLE AgentTokens;
        DROP TABLE Activations;
        DELETE FROM Challenges WHERE Purpose='agent';
        CREATE TABLE DevicesNext(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL, ProfileId TEXT NOT NULL REFERENCES Profiles(Id),
            Created INTEGER NOT NULL, LastSeen INTEGER, Revoked INTEGER, Revision INTEGER NOT NULL DEFAULT 1,
            Policy TEXT, AddedDefaultRoot INTEGER NOT NULL DEFAULT 0);
        INSERT INTO DevicesNext
            SELECT Id,Name,ProfileId,Created,LastSeen,Revoked,Revision,Policy,AddedDefaultRoot FROM Devices;
        DROP TABLE Devices;
        ALTER TABLE DevicesNext RENAME TO Devices;
        """;

    private const string MigrateJobOutput = """
        CREATE TABLE IF NOT EXISTS JobOutput(
            JobId TEXT NOT NULL REFERENCES Jobs(Id) ON DELETE CASCADE, Ordinal INTEGER NOT NULL,
            Stream TEXT NOT NULL, Data TEXT NOT NULL, PRIMARY KEY(JobId,Ordinal));
        """;

    private const string MigrateGateways = """
        CREATE TABLE FtpAccountsNext(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE, Owner TEXT NOT NULL REFERENCES Operators(Id),
            Mode TEXT NOT NULL CHECK(Mode IN ('ftp','ftps','sftp')), SecretHash TEXT NOT NULL,
            Disabled INTEGER NOT NULL DEFAULT 0, Failed INTEGER NOT NULL DEFAULT 0,
            LockUntil INTEGER NOT NULL DEFAULT 0, Revision INTEGER NOT NULL DEFAULT 1,
            Scope TEXT NOT NULL CHECK(Scope IN ('grants','activeHomes')), SecretCipher TEXT, PasswordChanged INTEGER);
        INSERT INTO FtpAccountsNext(Id,Name,Owner,Mode,SecretHash,Disabled,Failed,LockUntil,Revision,Scope)
        SELECT Id,Name,Owner,Mode,SecretHash,Disabled,Failed,LockUntil,Revision,'grants' FROM FtpAccounts;
        DROP TABLE FtpAccounts;
        ALTER TABLE FtpAccountsNext RENAME TO FtpAccounts;
        CREATE TABLE GatewayMounts(
            DeviceId TEXT PRIMARY KEY REFERENCES Devices(Id), Name TEXT NOT NULL COLLATE NOCASE UNIQUE);
        """;

    private const string Schema = """
        CREATE TABLE Operators(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE, DisplayName TEXT NOT NULL,
            Revision INTEGER NOT NULL DEFAULT 0);
        INSERT INTO Operators VALUES('a39ba529-af9d-43d8-8076-ed58ee7ccc78','administrator','FileSharing Administrator',0);
        CREATE TABLE Passkeys(
            CredentialId BLOB PRIMARY KEY, OperatorId TEXT NOT NULL REFERENCES Operators(Id), Data TEXT NOT NULL);
        CREATE INDEX PasskeysOperator ON Passkeys(OperatorId);
        CREATE TABLE Challenges(
            Hash TEXT PRIMARY KEY, Purpose TEXT NOT NULL, Owner TEXT NOT NULL, State TEXT NOT NULL, Expires INTEGER NOT NULL);
        CREATE TABLE Reviews(
            Id TEXT PRIMARY KEY, SecretHash TEXT NOT NULL UNIQUE, Initiator TEXT NOT NULL REFERENCES Operators(Id),
            Created INTEGER NOT NULL, Expires INTEGER NOT NULL, LastAccess INTEGER NOT NULL, Revoked INTEGER);
        CREATE INDEX ReviewsInitiator ON Reviews(Initiator,Expires);
        CREATE TABLE Profiles(Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE, Settings TEXT NOT NULL, Revision INTEGER NOT NULL);
        INSERT INTO Profiles VALUES('default','Default','{"cpu":0,"memory":0,"disk":60,"battery":60,"displays":0,"keepAwake":true}',1);
        CREATE TABLE Devices(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL, ProfileId TEXT NOT NULL REFERENCES Profiles(Id),
            Created INTEGER NOT NULL, LastSeen INTEGER, Revoked INTEGER, Revision INTEGER NOT NULL DEFAULT 1,
            Policy TEXT, AddedDefaultRoot INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE ObservedRoots(
            DeviceId TEXT NOT NULL REFERENCES Devices(Id), RootKey TEXT NOT NULL, Label TEXT NOT NULL, Writable INTEGER NOT NULL,
            [Primary] INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(DeviceId,RootKey));
        CREATE TABLE Roots(
            Id TEXT PRIMARY KEY, DeviceId TEXT NOT NULL REFERENCES Devices(Id), RootKey TEXT NOT NULL, Label TEXT NOT NULL,
            Writable INTEGER NOT NULL, Enabled INTEGER NOT NULL, Revision INTEGER NOT NULL DEFAULT 1, UNIQUE(DeviceId,RootKey));
        CREATE TABLE FtpAccounts(
            Id TEXT PRIMARY KEY, Name TEXT NOT NULL COLLATE NOCASE UNIQUE, Owner TEXT NOT NULL REFERENCES Operators(Id),
            Mode TEXT NOT NULL CHECK(Mode IN ('ftp','ftps')), SecretHash TEXT NOT NULL,
            Disabled INTEGER NOT NULL DEFAULT 0, Failed INTEGER NOT NULL DEFAULT 0,
            LockUntil INTEGER NOT NULL DEFAULT 0, Revision INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE FtpGrants(
            AccountId TEXT NOT NULL REFERENCES FtpAccounts(Id) ON DELETE CASCADE,
            RootId TEXT NOT NULL REFERENCES Roots(Id) ON DELETE CASCADE, PRIMARY KEY(AccountId,RootId));
        CREATE TABLE FtpResumes(
            AccountId TEXT NOT NULL REFERENCES FtpAccounts(Id) ON DELETE CASCADE,
            Path TEXT NOT NULL, Version TEXT NOT NULL, Updated INTEGER NOT NULL, PRIMARY KEY(AccountId,Path));
        CREATE TABLE Snapshots(
            DeviceId TEXT NOT NULL REFERENCES Devices(Id), Topic TEXT NOT NULL, At INTEGER NOT NULL, Payload TEXT NOT NULL,
            PRIMARY KEY(DeviceId,Topic));
        CREATE TABLE Events(
            Sequence INTEGER PRIMARY KEY AUTOINCREMENT, DeviceId TEXT NOT NULL REFERENCES Devices(Id), Topic TEXT NOT NULL,
            At INTEGER NOT NULL, Payload TEXT NOT NULL);
        CREATE INDEX EventsByDevice ON Events(DeviceId,Sequence);
        CREATE INDEX EventsByTime ON Events(At);
        CREATE TABLE AgentReceipts(
            DeviceId TEXT NOT NULL REFERENCES Devices(Id), FrameId TEXT NOT NULL, At INTEGER NOT NULL, PRIMARY KEY(DeviceId,FrameId));
        CREATE INDEX AgentReceiptsByTime ON AgentReceipts(At);
        CREATE TABLE Audit(
            Sequence INTEGER PRIMARY KEY AUTOINCREMENT, At INTEGER NOT NULL, Actor TEXT, DeviceId TEXT, Action TEXT NOT NULL, Detail TEXT NOT NULL);
        CREATE INDEX AuditByTime ON Audit(At);
        CREATE TABLE Jobs(
            Id TEXT PRIMARY KEY, Owner TEXT NOT NULL, DeviceId TEXT NOT NULL REFERENCES Devices(Id), Kind TEXT NOT NULL,
            State TEXT NOT NULL, Created INTEGER NOT NULL, Finished INTEGER, Result TEXT, Error TEXT, ReviewId TEXT NOT NULL);
        CREATE INDEX JobsOwner ON Jobs(Owner,Id);
        CREATE TABLE Transfers(
            Id TEXT PRIMARY KEY, Owner TEXT NOT NULL, DeviceId TEXT NOT NULL REFERENCES Devices(Id), RootId TEXT NOT NULL,
            Kind TEXT NOT NULL, State TEXT NOT NULL, Path TEXT NOT NULL, FileName TEXT NOT NULL, Version TEXT,
            Length INTEGER NOT NULL, Offset INTEGER NOT NULL, Created INTEGER NOT NULL, Updated INTEGER NOT NULL,
            Idempotency TEXT NOT NULL, Fingerprint TEXT NOT NULL, Error TEXT, UNIQUE(Owner,Idempotency));
        CREATE INDEX TransfersOwner ON Transfers(Owner,Id);
        """;
}

internal static class Clock
{
    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public static DateTimeOffset At(long seconds) => DateTimeOffset.FromUnixTimeSeconds(seconds);
}

internal static class Wire
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        MaxDepth = 24
    };

    public static string Encode<T>(T value) => JsonSerializer.Serialize(value, Json);
    public static JsonElement Element<T>(T value) => JsonSerializer.SerializeToElement(value, Json);
    public static JsonElement Parse(string raw) => JsonSerializer.Deserialize<JsonElement>(raw, Json);

    public static T Model<T>(JsonElement payload) =>
        payload.Deserialize<T>(Json) ?? throw Fault.Bad("invalid_body");
}
