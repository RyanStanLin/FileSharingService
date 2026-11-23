using Dapper;

namespace FileSharing;

internal sealed record AgentHello(string? Type, string DeviceId, string Name, string? NotificationKey);

internal sealed class AgentRegistration(Database db, Settings settings)
{
    public async Task Register(string id, string name, CancellationToken ct)
    {
        var now = Clock.Now;
        await db.Write(async (connection, tx) =>
        {
            var current = await connection.QuerySingleOrDefaultAsync<ExistingDevice>(new CommandDefinition(
                "SELECT Id,Revoked FROM Devices WHERE Id=@id", new { id }, tx, cancellationToken: ct));
            if (current?.Revoked is not null)
                throw Fault.Forbidden("device_revoked");
            if (current is null)
            {
                var inserted = await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO Devices(Id,Name,ProfileId,Created,LastSeen)
                    SELECT @id,@name,'default',@now,@now
                    WHERE (SELECT COUNT(*) FROM Devices WHERE Revoked IS NULL)<@MaxDevices
                    """, new { id, name, now, settings.MaxDevices }, tx, cancellationToken: ct));
                if (inserted != 1)
                    throw Fault.Conflict("device_capacity");
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO Audit(At,DeviceId,Action,Detail) VALUES(@now,@id,'device.registered','{}')
                    """, new { now, id }, tx, cancellationToken: ct));
            }
            else
            {
                await connection.ExecuteAsync(new CommandDefinition("""
                    UPDATE Devices SET LastSeen=@now WHERE Id=@id;
                    DELETE FROM ObservedRoots WHERE DeviceId=@id;
                    DELETE FROM Snapshots WHERE DeviceId=@id AND Topic='roots';
                    """, new { now, id }, tx, cancellationToken: ct));
            }
            return true;
        });
    }

    private sealed record ExistingDevice(string Id, long? Revoked);
}
