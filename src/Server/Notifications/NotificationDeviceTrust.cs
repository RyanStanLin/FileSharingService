using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed class NotificationDeviceTrust(Database db)
{
    public static string? Proof(string? key)
    {
        if (key is null)
            return null;
        if (key.Length != 43 || !key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            throw Fault.Bad("invalid_notification_identity");
        return Secrets.Hash(key);
    }

    public Task Bind(AgentBroker.Link link, CancellationToken ct) => db.Write(async (connection, tx) =>
    {
        if (link.NotificationProof is not { } proof)
            return false;
        await connection.ExecuteAsync(new CommandDefinition("""
            DELETE FROM NotificationSamples WHERE DeviceId=@Device AND NOT EXISTS
                (SELECT 1 FROM NotificationDevices WHERE DeviceId=@Device AND ProofHash=@proof);
            INSERT INTO NotificationDevices(DeviceId,ProofHash,ConnectionId,Online) VALUES(@Device,@proof,@Id,1)
            ON CONFLICT(DeviceId) DO UPDATE SET ProofHash=excluded.ProofHash,ConnectionId=excluded.ConnectionId,Online=1;
            """, new { link.Device, link.Id, proof }, tx, cancellationToken: ct));
        return true;
    });

    public static async Task<bool> Connect(SqliteConnection connection, SqliteTransaction tx, AgentBroker.Link link,
        AgentPresence presence, long source, long now, CancellationToken ct)
    {
        if (link.NotificationProof is not { } proof)
            return false;
        var previous = await connection.QuerySingleOrDefaultAsync<long?>(new CommandDefinition("""
            SELECT Online FROM NotificationDevices WHERE DeviceId=@Device AND ProofHash=@proof
            """, new { link.Device, proof }, tx, cancellationToken: ct));
        if (previous is null)
            return false;

        await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE NotificationDevices SET ConnectionId=@Id,Online=1 WHERE DeviceId=@Device
            """, new { link.Id, link.Device }, tx, cancellationToken: ct));
        if (previous == 0)
            await NotificationMatcher.Match(connection, tx, link.Device, source, now,
                [NotificationSignals.Presence(link, presence, true, now)], ct);
        return true;
    }

    public static async Task Disconnect(SqliteConnection connection, SqliteTransaction tx, AgentBroker.Link link,
        AgentPresence presence, long source, long now, bool stopping, CancellationToken ct)
    {
        if (!link.NotificationTrusted)
            return;
        var changed = await connection.ExecuteAsync(new CommandDefinition("""
            UPDATE NotificationDevices SET ConnectionId=NULL,Online=CASE WHEN @stopping=1 THEN Online ELSE 0 END
            WHERE DeviceId=@Device AND ConnectionId=@Id AND Online=1
            """, new { link.Device, link.Id, stopping }, tx, cancellationToken: ct));
        if (changed == 1 && !stopping)
            await NotificationMatcher.Match(connection, tx, link.Device, source, now,
                [NotificationSignals.Presence(link, presence, false, now)], ct);
    }
}
