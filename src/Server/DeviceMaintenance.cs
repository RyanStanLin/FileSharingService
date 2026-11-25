using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

/// <summary>The specific authorized connection on which to arm the maintenance window.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record StartMaintenanceRequest(string ConnectionId);

/// <summary>The current or most recent ten-minute maintenance window for a device.</summary>
internal sealed record DeviceMaintenanceView(string DeviceId, bool Supported, string State, string? LeaseId,
    DateTimeOffset? StartedAt, DateTimeOffset? ExpiresAt, DateTimeOffset? ConfirmedAt, DateTimeOffset? EndedAt, int RemainingSeconds);

/// <summary>The time remaining on the ticket's original deadline. Zero releases the local wait.</summary>
internal sealed record MaintenanceTicket(long RemainingMilliseconds);

internal interface IDeviceMaintenance
{
    Task<DeviceMaintenanceView> Status(string device, CancellationToken ct);
    Task<DeviceMaintenanceView> Start(string device, string connectionId, string actor, CancellationToken ct);
    Task End(string device, string leaseId, string actor, CancellationToken ct);
    Task<MaintenanceTicket> CheckTicket(string leaseId, string? token, CancellationToken ct);
}

internal sealed class DeviceMaintenance(Database db, DeviceService devices, AgentBroker broker, ILogger<DeviceMaintenance> logger) : IDeviceMaintenance
{
    internal const string ArmCommand = "maintenance.arm";
    internal const string TicketHeader = "X-FileSharing-Maintenance";
    internal const string Topic = "maintenance.changed";
    private const long WindowMilliseconds = 600_000;
    private const long PreparationMilliseconds = 18_000;

    public const string Migration = """
        CREATE TABLE DeviceMaintenance(
            DeviceId TEXT PRIMARY KEY REFERENCES Devices(Id),
            LeaseId TEXT NOT NULL UNIQUE, TicketHash TEXT NOT NULL,
            Started INTEGER NOT NULL, Expires INTEGER NOT NULL, Confirmed INTEGER, Ended INTEGER);
        """;

    public async Task<DeviceMaintenanceView> Status(string device, CancellationToken ct)
    {
        await devices.Require(device, ct);
        var lease = await db.One<Lease>("SELECT * FROM DeviceMaintenance WHERE DeviceId=@device", new { device }, ct);
        return View(device, lease);
    }

    public async Task<DeviceMaintenanceView> Start(string device, string connectionId, string actor, CancellationToken ct)
    {
        await devices.Require(device, ct);
        var link = broker.AccessibleLink(device, Secrets.Identifier(connectionId));
        if (!link.MaintenanceSupported)
            throw new Fault(422, "maintenance_agent_upgrade_required");
        var generation = broker.AccessGeneration(link) ?? throw Fault.Forbidden("agent_connection_access_required");
        var token = Secrets.New();
        var draft = await Reserve(device, Secrets.Hash(token), ct);
        try
        {
            var reply = await broker.Invoke(device, ArmCommand, new { draft.LeaseId, ticket = token }, ct,
                commandId: draft.LeaseId, timeout: TimeSpan.FromSeconds(12), connectionId: link.Id);
            if (reply.ValueKind != JsonValueKind.Object || !reply.TryGetProperty("leaseId", out var echoed) ||
                echoed.ValueKind != JsonValueKind.String || echoed.GetString() != draft.LeaseId)
                throw Fault.Unavailable("maintenance_receipt_invalid");
            if (broker.AccessGeneration(link) != generation)
                throw Fault.Forbidden("agent_connection_access_required");

            var confirmed = await Confirm(draft, actor, ct);
            return View(device, confirmed);
        }
        catch
        {
            try
            {
                await db.Execute("""
                    UPDATE DeviceMaintenance SET Ended=@now
                    WHERE LeaseId=@LeaseId AND Confirmed IS NULL AND Ended IS NULL
                    """, new { draft.LeaseId, now = Now }, CancellationToken.None);
            }
            catch (Exception error)
            {
                logger.LogWarning(error, "Could not release unconfirmed maintenance lease {LeaseId}", draft.LeaseId);
            }
            throw;
        }
    }

    public async Task End(string device, string leaseId, string actor, CancellationToken ct)
    {
        await devices.Require(device, ct);
        Secrets.Identifier(leaseId);
        await db.Write(async (connection, transaction) =>
        {
            var current = await Read(connection, transaction, device, ct);
            if (current?.LeaseId != leaseId)
                throw Fault.Missing("maintenance_lease_not_found");
            var now = Now;
            if (!current.CanWait(now))
                return false;

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE DeviceMaintenance SET Ended=@now WHERE DeviceId=@device AND LeaseId=@leaseId
                """, new { device, leaseId, now }, transaction, cancellationToken: ct));
            await RecordChange(connection, transaction, actor, current with { Ended = now }, ct);
            return true;
        });
    }

    public async Task<MaintenanceTicket> CheckTicket(string leaseId, string? token, CancellationToken ct)
    {
        Secrets.Identifier(leaseId);
        if (token is not { Length: 43 } || !token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            throw Fault.Missing("maintenance_ticket_not_found");
        var lease = await db.One<Lease>("""
            SELECT m.* FROM DeviceMaintenance m JOIN Devices d ON d.Id=m.DeviceId AND d.Revoked IS NULL
            WHERE m.LeaseId=@leaseId AND m.TicketHash=@hash
            """, new { leaseId, hash = Secrets.Hash(token) }, ct) ?? throw Fault.Missing("maintenance_ticket_not_found");
        return new(lease.Remaining(Now));
    }

    private Task<Lease> Reserve(string device, string hash, CancellationToken ct) => db.Write(async (connection, transaction) =>
    {
        var now = Now;
        if (!await connection.ExecuteScalarAsync<bool>(new CommandDefinition("""
            SELECT EXISTS(SELECT 1 FROM Devices WHERE Id=@device AND Revoked IS NULL)
            """, new { device }, transaction, cancellationToken: ct)))
            throw Fault.Missing("device_not_found");
        if ((await Read(connection, transaction, device, ct))?.CanWait(now) == true)
            throw Fault.Conflict("maintenance_already_open");

        var lease = new Lease(device, Secrets.Id(), hash, now, now + WindowMilliseconds, null, null);
        await connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO DeviceMaintenance(DeviceId,LeaseId,TicketHash,Started,Expires) VALUES(@DeviceId,@LeaseId,@TicketHash,@Started,@Expires)
            ON CONFLICT(DeviceId) DO UPDATE SET LeaseId=excluded.LeaseId,TicketHash=excluded.TicketHash,
                Started=excluded.Started,Expires=excluded.Expires,Confirmed=NULL,Ended=NULL
            """, lease, transaction, cancellationToken: ct));
        return lease;
    });

    private Task<Lease> Confirm(Lease draft, string actor, CancellationToken ct) => db.Write(async (connection, transaction) =>
    {
        var now = Now;
        var confirmed = await connection.QuerySingleOrDefaultAsync<Lease>(new CommandDefinition("""
            UPDATE DeviceMaintenance SET Confirmed=@now WHERE LeaseId=@LeaseId AND Ended IS NULL AND Confirmed IS NULL
                AND Expires>@now AND Started>@prepareCutoff
                AND EXISTS (SELECT 1 FROM Devices WHERE Id=@DeviceId AND Revoked IS NULL)
            RETURNING *
            """, new { draft.LeaseId, draft.DeviceId, now, prepareCutoff = now - PreparationMilliseconds }, transaction, cancellationToken: ct))
            ?? throw Fault.Conflict("maintenance_lease_ended");
        await RecordChange(connection, transaction, actor, confirmed, ct);
        return confirmed;
    });

    private DeviceMaintenanceView View(string device, Lease? lease)
    {
        var supported = broker.SupportsMaintenance(device);
        if (lease is null)
            return new(device, supported, "inactive", null, null, null, null, null, 0);
        var now = Now;
        var state = lease.Ended is not null ? "ended" : !lease.CanWait(now) ? "expired" :
            lease.Confirmed is null ? "preparing" : "active";
        return new(device, supported, state, lease.LeaseId, DateTimeOffset.FromUnixTimeMilliseconds(lease.Started),
            DateTimeOffset.FromUnixTimeMilliseconds(lease.Expires), Time(lease.Confirmed), Time(lease.Ended),
            (int)((lease.Remaining(now) + 999) / 1000));
    }

    private static DateTimeOffset? Time(long? milliseconds) =>
        milliseconds is { } time ? DateTimeOffset.FromUnixTimeMilliseconds(time) : null;

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static Task<Lease?> Read(SqliteConnection connection, SqliteTransaction transaction, string device, CancellationToken ct) =>
        connection.QuerySingleOrDefaultAsync<Lease>(new CommandDefinition("SELECT * FROM DeviceMaintenance WHERE DeviceId=@device",
            new { device }, transaction, cancellationToken: ct));

    private static Task RecordChange(SqliteConnection connection, SqliteTransaction transaction, string actor, Lease lease, CancellationToken ct)
    {
        var started = DateTimeOffset.FromUnixTimeMilliseconds(lease.Started);
        var expires = DateTimeOffset.FromUnixTimeMilliseconds(lease.Expires);
        var payload = Wire.Encode(new
        {
            lease.LeaseId, state = lease.Ended is null ? "active" : "ended", startedAt = started, expiresAt = expires, endedAt = Time(lease.Ended)
        });
        var action = lease.Ended is null ? "device.maintenance_started" : "device.maintenance_ended";
        return connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO Audit(At,Actor,DeviceId,Action,Detail) VALUES(@at,@actor,@DeviceId,@action,@payload);
            INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@DeviceId,@topic,@at,@payload);
            """, new { at = Clock.Now, actor, lease.DeviceId, action, topic = Topic, payload }, transaction, cancellationToken: ct));
    }

    private sealed record Lease(string DeviceId, string LeaseId, string TicketHash, long Started, long Expires, long? Confirmed, long? Ended)
    {
        public bool CanWait(long now) => Ended is null && Expires > now && (Confirmed is not null || Started + PreparationMilliseconds > now);
        public long Remaining(long now) => CanWait(now) ? Math.Min(Expires - now, WindowMilliseconds) : 0;
    }
}
