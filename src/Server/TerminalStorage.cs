using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace FileSharing;

internal sealed record TerminalRecord(string Id, string DeviceId, string RootId, string Owner, string KeyHash,
    string? ConnectionId, string State, long Created, long Updated, long? Finished, long Cursor, long AgentCursor,
    string? CommandId, long Started, string? Pending, string? Prompt, long Interactive, string? Code)
{
    public bool Closed => State == "terminated";
}

internal sealed record TerminalDispatch(string Kind, string? CommandId = null, string? Executable = null,
    string[]? Arguments = null, string? Path = null);
internal sealed record TerminalSync(string? ConnectionId, IReadOnlyList<TerminalFrame>? Frames);
internal sealed record TerminalSyncResult(long Acknowledged, bool Terminate, TerminalDispatch? Command, bool Deleted = false);
internal sealed record TerminalTitle(string Id, string Line);

internal sealed class TerminalStorage(Database db)
{
    public const int PageCapacity = 256;

    public const string Migration = """
        CREATE TABLE TerminalSessions(
            Id TEXT PRIMARY KEY, DeviceId TEXT NOT NULL, RootId TEXT NOT NULL, Owner TEXT NOT NULL, KeyHash TEXT NOT NULL,
            ConnectionId TEXT, State TEXT NOT NULL CHECK(State IN ('starting','open','terminating','terminated')),
            Created INTEGER NOT NULL, Updated INTEGER NOT NULL, Finished INTEGER, Cursor INTEGER NOT NULL DEFAULT 0,
            AgentCursor INTEGER NOT NULL DEFAULT 0, CommandId TEXT, Started INTEGER NOT NULL DEFAULT 0,
            Pending TEXT, Prompt TEXT, Interactive INTEGER NOT NULL DEFAULT 0, Code TEXT);
        CREATE INDEX TerminalSessionsOwner ON TerminalSessions(Owner,DeviceId,Id);
        CREATE INDEX TerminalSessionsDeviceState ON TerminalSessions(DeviceId,State);
        CREATE TABLE TerminalFrames(
            SessionId TEXT NOT NULL REFERENCES TerminalSessions(Id) ON DELETE CASCADE,
            Ordinal INTEGER NOT NULL, Payload TEXT NOT NULL, PRIMARY KEY(SessionId,Ordinal));
        CREATE TABLE TerminalInputReceipts(
            SessionId TEXT NOT NULL REFERENCES TerminalSessions(Id) ON DELETE CASCADE,
            Id TEXT NOT NULL, PRIMARY KEY(SessionId,Id));
        CREATE TABLE TerminalDeletions(Id TEXT PRIMARY KEY, KeyHash TEXT NOT NULL);
        """;

    public Task<TerminalRecord?> Find(string id, CancellationToken ct) =>
        db.One<TerminalRecord>("SELECT * FROM TerminalSessions WHERE Id=@id", new { id }, ct);

    public Task<IReadOnlyList<TerminalRecord>> List(string owner, string deviceId, string after, int count, CancellationToken ct) =>
        db.List<TerminalRecord>("""
            SELECT * FROM TerminalSessions WHERE Owner=@owner AND DeviceId=@deviceId AND Id>@after ORDER BY Id LIMIT @count
            """, new { owner, deviceId, after, count }, ct);

    public Task<TerminalRecord?> Active(string owner, string deviceId, CancellationToken ct) =>
        db.One<TerminalRecord>("""
            SELECT * FROM TerminalSessions WHERE Owner=@owner AND DeviceId=@deviceId AND State<>'terminated'
            ORDER BY Created DESC LIMIT 1
            """, new { owner, deviceId }, ct);

    public async Task<IReadOnlyDictionary<string, string>> Titles(string[] ids, CancellationToken ct) =>
        (await db.List<TerminalTitle>("""
            SELECT s.Id, (SELECT json_extract(f.Payload,'$.line') FROM TerminalFrames f
                         WHERE f.SessionId=s.Id AND json_extract(f.Payload,'$.kind')='command'
                         ORDER BY f.Ordinal LIMIT 1) AS Line
            FROM TerminalSessions s WHERE s.Id IN @ids
            """, new { ids }, ct)).Where(item => item.Line is not null).ToDictionary(item => item.Id, item => item.Line);

    public Task Create(TerminalRecord row, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var existing = await connection.QueryAsync<TerminalRecord>(new CommandDefinition("""
            SELECT * FROM TerminalSessions WHERE DeviceId=@DeviceId AND State<>'terminated'
            """, row, tx, cancellationToken: ct));
        foreach (var prior in existing)
        {
            if (prior.AgentCursor != 0 || prior.Created > Clock.Now - 60)
                throw Fault.Conflict("terminal_busy");
            var closed = await Append(connection, tx, prior, new(0, "closed", Code: "terminal_start_failed"), ct);
            await Save(connection, tx, closed with { State = "terminated", Finished = Clock.Now, Code = "terminal_start_failed" }, ct);
        }
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO TerminalSessions(Id,DeviceId,RootId,Owner,KeyHash,ConnectionId,State,Created,Updated)
            VALUES(@Id,@DeviceId,@RootId,@Owner,@KeyHash,@ConnectionId,@State,@Created,@Updated)
            """, row, tx, cancellationToken: ct));
        return true;
    });

    public Task<IReadOnlyList<string>> Frames(string id, long after, long last, CancellationToken ct) =>
        db.List<string>("""
            SELECT Payload FROM TerminalFrames WHERE SessionId=@id AND Ordinal>@after AND Ordinal<=@last
            ORDER BY Ordinal LIMIT @limit
            """, new { id, after, last, limit = PageCapacity }, ct);

    public Task Begin(string id, string commandId, string line, TerminalDispatch command, CancellationToken ct) =>
        db.Write(async (connection, tx) =>
        {
            var row = await Locked(connection, tx, id, ct);
            if (row.State != "open")
                throw Fault.Conflict("terminal_closed");
            if (row.CommandId is not null)
                throw Fault.Conflict("terminal_busy");
            row = await Append(connection, tx, row, new(0, "command", commandId, Line: line, Prompt: row.Prompt), ct);
            await Save(connection, tx, row with { CommandId = commandId, Started = 0, Pending = Wire.Encode(command) }, ct);
            return true;
        });

    public Task Terminate(string id, string code, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var row = await Locked(connection, tx, id, ct);
        if (row.Closed || row.State == "terminating")
            return true;
        row = await Append(connection, tx, row, new(0, "terminating", Code: code), ct);
        await Save(connection, tx, row with { State = "terminating", Pending = null, Code = code }, ct);
        return true;
    });

    public Task CloseFailedStart(string id, string code, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var row = await Locked(connection, tx, id, ct);
        if (row.State != "starting" || row.AgentCursor != 0)
            return false;
        row = await Append(connection, tx, row, new(0, "closed", Code: code), ct);
        await Save(connection, tx, row with { State = "terminated", Finished = Clock.Now, Code = code }, ct);
        return true;
    });

    public Task Delete(string id, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var row = await Locked(connection, tx, id, ct);
        if (!row.Closed)
            throw Fault.Conflict("terminal_still_running");
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO TerminalDeletions(Id,KeyHash) VALUES(@Id,@KeyHash);
            DELETE FROM TerminalSessions WHERE Id=@Id;
            """, row, tx, cancellationToken: ct));
        return true;
    });

    public async Task<bool> WasDeleted(string id, string key, CancellationToken ct) =>
        await db.One<string>("SELECT KeyHash FROM TerminalDeletions WHERE Id=@id", new { id }, ct) is { } hash &&
        Matches(hash, key);

    public async Task<bool> HasInput(string session, string id, CancellationToken ct) =>
        await db.One<int>("SELECT EXISTS(SELECT 1 FROM TerminalInputReceipts WHERE SessionId=@session AND Id=@id)",
            new { session, id }, ct) != 0;

    public Task RecordInput(string session, string id, CancellationToken ct) =>
        db.Execute("INSERT OR IGNORE INTO TerminalInputReceipts(SessionId,Id) VALUES(@session,@id)", new { session, id }, ct);

    public Task<TerminalRecord> Synchronize(string id, string key, string? connectionId, IReadOnlyList<TerminalFrame> frames,
        CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        var row = await Locked(connection, tx, id, ct);
        if (!Matches(row.KeyHash, key))
            throw Fault.Missing("terminal_not_found");

        var initial = row;
        if (!row.Closed && await connection.ExecuteScalarAsync<int>(new CommandDefinition("""
            SELECT EXISTS(SELECT 1 FROM Devices d JOIN Roots r ON r.DeviceId=d.Id
                WHERE d.Id=@DeviceId AND d.Revoked IS NULL AND r.Id=@RootId AND r.Enabled=1)
            """, row, tx, cancellationToken: ct)) == 0 && row.State != "terminating")
        {
            row = await Append(connection, tx, row, new(0, "terminating", Code: "terminal_access_revoked"), ct);
            row = row with { State = "terminating", Pending = null, Code = "terminal_access_revoked" };
        }
        if (connectionId is not null && !row.Closed)
            row = row with { ConnectionId = connectionId };
        foreach (var frame in frames)
        {
            if (frame.Index <= row.AgentCursor)
                continue;
            if (frame.Index != row.AgentCursor + 1)
                throw Fault.Conflict("terminal_sync_gap");
            row = await Apply(connection, tx, row, frame, ct);
        }
        if (row != initial)
            await Save(connection, tx, row, ct);
        return row;
    });

    private static async Task<TerminalRecord> Apply(System.Data.IDbConnection connection, System.Data.IDbTransaction tx,
        TerminalRecord row, TerminalFrame frame, CancellationToken ct)
    {
        var sourceIndex = frame.Index;
        var at = frame.At;
        string? code = ValidCode(frame.Code);
        TerminalFrame persisted;
        switch (frame.Kind)
        {
            case "ready" when row.AgentCursor == 0:
                row = row with { State = row.State == "starting" ? "open" : row.State,
                    Prompt = ValidPrompt(frame.Prompt), Interactive = frame.Interactive == true ? 1 : 0 };
                persisted = new(0, "ready", Prompt: row.Prompt, Interactive: row.Interactive != 0, At: at);
                break;
            case "started" when row.CommandId is not null && row.CommandId == frame.CommandId && row.Started == 0:
                row = row with { Started = 1, Pending = null };
                persisted = new(0, "started", row.CommandId, At: at);
                break;
            case "output" when ValidOutput(frame.Data):
                persisted = new(0, "output", row.CommandId, Data: frame.Data, At: at);
                break;
            case "exit" when row.CommandId is not null && row.CommandId == frame.CommandId && frame.ExitCode is >= 0 and <= 255:
                row = row with { Prompt = ValidPrompt(frame.Prompt) ?? row.Prompt };
                persisted = new(0, "exit", row.CommandId, ExitCode: frame.ExitCode, Code: code, Prompt: row.Prompt, At: at);
                row = row with { CommandId = null, Started = 0, Pending = null };
                break;
            case "closed" or "error":
                code = row.Code ?? code ?? "terminal_closed";
                persisted = new(0, "closed", CommandId: row.CommandId, Code: code, At: at);
                row = row with { State = "terminated", Finished = CapturedAt(at), CommandId = null, Started = 0,
                    Pending = null, Code = code };
                break;
            default:
                throw Fault.Bad("invalid_terminal_frame");
        }
        return await Append(connection, tx, row with { AgentCursor = sourceIndex }, persisted, ct);
    }

    private static async Task<TerminalRecord> Locked(System.Data.IDbConnection connection, System.Data.IDbTransaction tx,
        string id, CancellationToken ct) => await connection.QuerySingleOrDefaultAsync<TerminalRecord>(new CommandDefinition("""
            SELECT * FROM TerminalSessions WHERE Id=@id
            """, new { id }, tx, cancellationToken: ct)) ?? throw Fault.Missing("terminal_not_found");

    private static Task Save(System.Data.IDbConnection connection, System.Data.IDbTransaction tx, TerminalRecord row, CancellationToken ct) =>
        connection.ExecuteAsync(new CommandDefinition("""
            UPDATE TerminalSessions SET ConnectionId=@ConnectionId,State=@State,Updated=@Updated,Finished=@Finished,
                Cursor=@Cursor,AgentCursor=@AgentCursor,CommandId=@CommandId,Started=@Started,Pending=@Pending,
                Prompt=@Prompt,Interactive=@Interactive,Code=@Code WHERE Id=@Id
            """, row, tx, cancellationToken: ct));

    private static async Task<TerminalRecord> Append(System.Data.IDbConnection connection, System.Data.IDbTransaction tx,
        TerminalRecord row, TerminalFrame frame, CancellationToken ct)
    {
        var index = row.Cursor + 1;
        var now = Clock.Now;
        var captured = CapturedAt(frame.At);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO TerminalFrames(SessionId,Ordinal,Payload) VALUES(@Id,@index,@payload)
            """, new { row.Id, index, payload = Wire.Encode(frame with { Index = index, At = captured }) }, tx, cancellationToken: ct));
        return row with { Cursor = index, Updated = now };
    }

    private static bool ValidOutput(string? value)
    {
        Span<byte> buffer = stackalloc byte[2048];
        return value is { Length: > 0 and <= 2732 } && Convert.TryFromBase64String(value, buffer, out var count) && count > 0;
    }

    private static long CapturedAt(long? time) => time is >= 0 && time <= Clock.Now + 86_400 ? time.Value : Clock.Now;

    private static bool Matches(string hash, string key) =>
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(Secrets.Hash(key)));

    private static string? ValidPrompt(string? value) =>
        value is { Length: > 0 and <= 512 } && !value.Any(char.IsControl) ? value : null;

    private static string? ValidCode(string? value) =>
        value is { Length: > 0 and <= 64 } && value.All(c => c is >= 'a' and <= 'z' or '_') ? value : null;
}
