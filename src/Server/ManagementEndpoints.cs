using System.Text.Json;
using Dapper;

namespace FileSharing;

internal sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor)
{
    public static Page<T> From(IReadOnlyList<T> rows, int take, Func<T, string> key) =>
        rows.Count <= take ? new(rows, null) : new(rows.Take(take).ToArray(), key(rows[take - 1]));

    public static int Size(int? size) => size is null ? 50 :
        size is >= 1 and <= 200 ? size.Value : throw Fault.Bad("invalid_limit");

    public static string After(string? cursor) => cursor is null ? "" : Secrets.Identifier(cursor);
}

internal sealed record DeviceRecord(string Id, string Name, string ProfileId, long Created, long? LastSeen, long? Revoked, long Revision)
{
    public DeviceView View(AgentBroker broker) => new(Id, Name, ProfileId, Clock.At(Created), Revoked is { } end ? Clock.At(end) : null,
        Revision, broker.Presence(Id, LastSeen));
}
internal sealed record DeviceView(string Id, string Name, string ProfileId, DateTimeOffset CreatedAt, DateTimeOffset? RevokedAt,
    long Revision, AgentPresence Connection);
internal sealed record DeviceInput(string Name, string ProfileId, long Revision);
internal sealed record Sampling(int Cpu, int Memory, int Disk, int Battery, int Displays, bool KeepAwake,
    int Network = 30, int System = 60, int Agent = 60, int Power = 60, int Storage = 60, int AppsRunning = 60)
{
    public void Validate()
    {
        foreach (var value in new[] { Cpu, Memory, Disk, Battery, Displays, Network, System, Agent, Power, Storage, AppsRunning })
            if (value != 0 && value is < 5 or > 3600)
                throw Fault.Bad("invalid_sampling_interval");
    }
}
internal sealed record DevicePolicyInput(long Revision, Sampling? Settings);
internal sealed record DevicePolicy(string DeviceId, long Revision, bool Inherited, Sampling Settings);
internal sealed record PolicyRecord(string Id, long Revision, string? Policy, string Defaults);
internal sealed record ProfileInput(string Name, Sampling Settings, long? Revision);
internal sealed record ProfileRecord(string Id, string Name, string Settings, long Revision)
{
    public ProfileView View => new(Id, Name, Wire.Model<Sampling>(Wire.Parse(Settings)), Revision);
}
internal sealed record ProfileView(string Id, string Name, Sampling Settings, long Revision);
internal sealed record ConnectionAccessInput(string ConnectionId, bool Enabled);
internal sealed record RootInfo(string Id, string DeviceId, string RootKey, string Label, bool Writable, bool Enabled, long Revision)
{
    public RootInfo() : this("", "", "", "", false, false, 0) { }

    [System.Text.Json.Serialization.JsonIgnore]
    public string? ConnectionId { get; init; }
}
internal sealed record RootInput(string RootKey, string Label, bool Writable, bool Enabled, long? Revision);
internal sealed record AuditRecord(long Sequence, long At, string? Actor, string? DeviceId, string Action, string Detail)
{
    public AuditView View => new(Sequence.ToString(), Clock.At(At), Actor, DeviceId, Action, Wire.Parse(Detail));
}
internal sealed record AuditView(string Sequence, DateTimeOffset Time, string? Actor, string? DeviceId, string Action, JsonElement Detail);

internal sealed class DeviceService(Database db, AgentBroker broker)
{
    public Task<DeviceRecord?> Find(string id, CancellationToken ct) =>
        db.One<DeviceRecord>("SELECT Id,Name,ProfileId,Created,LastSeen,Revoked,Revision FROM Devices WHERE Id=@id", new { id }, ct);

    public async Task<DeviceRecord> Require(string id, CancellationToken ct) =>
        await Find(Secrets.Identifier(id), ct) is { Revoked: null } device ? device : throw Fault.Missing("device_not_found");

    public async Task<RootInfo> Scope(string device, string root, bool write, CancellationToken ct, string? connectionId = null, string? path = null)
    {
        Secrets.Identifier(device);
        Secrets.Identifier(root);
        var activeConnection = connectionId ?? broker.Presence(device).ConnectionId;
        var parts = path?.Split('/', 2) ?? [];
        var first = parts.FirstOrDefault();
        var readOnlyHomePath = string.Equals(first, "Library", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(first, "Applications", StringComparison.OrdinalIgnoreCase);
        var permission = parts.Length == 2 && first is ("Downloads" or "Documents" or "Desktop")
            ? first.ToLowerInvariant() : null;
        var record = await db.One<RootInfo>("""
            SELECT r.* FROM Roots r JOIN Devices d ON d.Id=r.DeviceId JOIN ObservedRoots o ON o.DeviceId=r.DeviceId AND o.RootKey=r.RootKey
            WHERE r.DeviceId=@device AND r.Id=@root AND r.Enabled=1 AND d.Revoked IS NULL
              AND (@write=0 OR ((o.[Primary]=0 OR @readOnlyHomePath=0) AND (
                (o.Writable=1 AND r.Writable=1) OR (o.[Primary]=1 AND o.Writable=0 AND @permission IS NOT NULL
                  AND (r.Writable=1 OR (r.Revision=1 AND NOT EXISTS(
                    SELECT 1 FROM Audit a WHERE a.DeviceId=@device AND a.Action='root.created' AND json_extract(a.Detail,'$.id')=r.Id)))
                  AND EXISTS (
                    SELECT 1 FROM Snapshots s WHERE s.DeviceId=@device AND s.Topic='permissions'
                    AND (s.Payload -> @permission ->> 'state')='allowed'
                    AND (s.Payload -> @permission ->> 'phase')='completed'
                    AND json_type(s.Payload -> @permission,'$.writable')='true'
                ))
              )))
            """, new { device, root, write, readOnlyHomePath, permission }, ct);
        if (record is null)
            throw Fault.Forbidden("root_access_denied");
        if (activeConnection is null)
            throw Fault.Unavailable();
        return record with { ConnectionId = broker.RequireAccess(device, activeConnection) };
    }

    public async Task<DevicePolicy> Policy(string device, CancellationToken ct)
    {
        var row = await db.One<PolicyRecord>("""
            SELECT d.Id,d.Revision,d.Policy,p.Settings AS Defaults
            FROM Profiles p JOIN Devices d ON d.ProfileId=p.Id WHERE d.Id=@device AND d.Revoked IS NULL
            """, new { device }, ct) ?? throw Fault.Missing("device_not_found");
        return new(device, row.Revision, row.Policy is null, Wire.Model<Sampling>(Wire.Parse(row.Policy ?? row.Defaults)));
    }

    public static string Match(string value) => value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
}

internal static class ManagementEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var devices = api.MapGroup("/devices").WithTags("Devices");
        devices.MapGet("/", ListDevices).WithSummary("List devices and live connection status");
        devices.MapGet("/{id}", GetDevice).WithSummary("Read a device");
        devices.MapPut("/{id}", UpdateDevice).WithSummary("Update a device with a revision check");
        devices.MapGet("/{id}/policy", GetPolicy).WithSummary("Get effective per-device collection and lid policy");
        devices.MapPut("/{id}/policy", UpdatePolicy).WithSummary("Override collection and lid settings for one device");
        devices.MapPut("/{id}/connection-access", UpdateConnectionAccess)
            .WithSummary("Grant or revoke remote access on the current live device connection");
        devices.MapDelete("/{id}", RevokeDevice).WithSummary("Revoke a device and release its slot");

        var profiles = api.MapGroup("/collection-profiles").WithTags("Collection profiles");
        profiles.MapGet("/", ListProfiles).WithSummary("List collection profiles");
        profiles.MapPost("/", CreateProfile).WithSummary("Create a collection profile");
        profiles.MapGet("/{id}", GetProfile).WithSummary("Read a collection profile");
        profiles.MapPut("/{id}", UpdateProfile).WithSummary("Update a collection profile");
        profiles.MapDelete("/{id}", DeleteProfile).WithSummary("Remove an unused profile");

        var roots = devices.MapGroup("/{id}/file-roots").WithTags("File roots");
        roots.MapGet("/local", LocalRoots).WithSummary("List roots explicitly approved on the Mac");
        roots.MapGet("/", ListRoots).WithSummary("List the device's server-side file grants");
        roots.MapPost("/", CreateRoot).WithSummary("Create a grant for a locally approved root");
        roots.MapGet("/{rootId}", GetRoot).WithSummary("Read a file grant");
        roots.MapPut("/{rootId}", UpdateRoot).WithSummary("Update a root grant");
        roots.MapDelete("/{rootId}", DeleteRoot).WithSummary("Revoke the root grant");

        api.MapGet("/audit", ListAudit).WithTags("Audit").WithSummary("Query immutable audit records");
    }

    private static async Task<Ok<Page<DeviceView>>> ListDevices(string? cursor, int? limit, string? search, bool? includeRevoked,
        HttpContext ctx, Database db, ReviewService reviews, AgentBroker broker, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var take = Page<DeviceView>.Size(limit);
        var rows = await db.List<DeviceRecord>("""
            SELECT Id,Name,ProfileId,Created,LastSeen,Revoked,Revision FROM Devices
            WHERE Id>@after AND (@all=1 OR Revoked IS NULL) AND Name LIKE @query ESCAPE '\'
            ORDER BY Id LIMIT @size
            """, new { after = Page<DeviceView>.After(cursor), all = includeRevoked == true, query = $"%{DeviceService.Match(search ?? "")}%", size = take + 1 }, ct);
        return TypedResults.Ok(Page<DeviceView>.From(rows.Select(x => x.View(broker)).ToArray(), take, x => x.Id));
    }

    private static async Task<Ok<DeviceView>> GetDevice(string id, HttpContext ctx, DeviceService devices, ReviewService reviews,
        AgentBroker broker, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var row = await devices.Find(Secrets.Identifier(id), ct) ?? throw Fault.Missing();
        return TypedResults.Ok(row.View(broker));
    }

    private static async Task<Ok<DeviceView>> UpdateDevice(string id, DeviceInput body, HttpContext ctx, Database db, DeviceService devices,
        ReviewService reviews, AgentBroker broker, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        var name = Secrets.Text(body.Name);
        var changed = await db.Mutate("""
            UPDATE Devices SET Name=@name,ProfileId=@ProfileId,Revision=Revision+1
            WHERE Id=@id AND Revoked IS NULL AND Revision=@Revision AND EXISTS(SELECT 1 FROM Profiles WHERE Id=@ProfileId)
            """, new { id, name, body.ProfileId, body.Revision }, review.Initiator, id, "device.updated", new { id }, ct);
        if (!changed)
            throw Fault.Conflict("profile_or_revision_conflict");
        return TypedResults.Ok((await devices.Require(id, ct)).View(broker));
    }

    private static async Task<Ok<DevicePolicy>> GetPolicy(string id, HttpContext ctx, DeviceService devices,
        ReviewService sessions, CancellationToken ct)
    {
        await sessions.Require(ctx, ct);
        return TypedResults.Ok(await devices.Policy(Secrets.Identifier(id), ct));
    }

    private static async Task<Ok<DevicePolicy>> UpdatePolicy(string id, DevicePolicyInput body, HttpContext ctx,
        Database db, DeviceService devices, ReviewService sessions, CancellationToken ct)
    {
        var session = await sessions.Require(ctx, ct);
        await devices.Require(id, ct);
        body.Settings?.Validate();
        var policy = body.Settings is null ? null : Wire.Encode(body.Settings);
        if (!await db.Mutate("""
            UPDATE Devices SET Policy=@policy,Revision=Revision+1 WHERE Id=@id AND Revoked IS NULL AND Revision=@Revision
            """, new { id, policy, body.Revision }, session.Initiator, id, "device.policy_updated", new { body.Settings }, ct))
            throw Fault.Conflict("revision_conflict");
        return TypedResults.Ok(await devices.Policy(id, ct));
    }

    private static async Task<Ok<AgentPresence>> UpdateConnectionAccess(string id, ConnectionAccessInput body,
        HttpContext context, ReviewService sessions, DeviceService devices, AgentBroker broker, TerminalSessions terminals, CancellationToken ct)
    {
        var session = await sessions.Require(context, ct);
        await devices.Require(id, ct);
        var connectionId = Secrets.Identifier(body.ConnectionId);
        var presence = await broker.SetAccess(id, connectionId, body.Enabled, session.Initiator, ct);
        if (!body.Enabled)
            await terminals.StopDevice(id, CancellationToken.None);
        return TypedResults.Ok(presence);
    }

    private static async Task<NoContent> RevokeDevice(string id, HttpContext ctx, Database db, ReviewService reviews,
        AgentBroker broker, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        Secrets.Identifier(id);
        if (!await db.Mutate("UPDATE Devices SET Revoked=@now,Revision=Revision+1 WHERE Id=@id AND Revoked IS NULL",
            new { id, now = Clock.Now }, review.Initiator, id, "device.revoked", new { id }, ct,
            (connection, tx, token) => NotificationDeliveries.CancelForSource(connection, tx, id, null, token)))
            throw Fault.Missing();
        await broker.Revoke(id, CancellationToken.None);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<Page<ProfileView>>> ListProfiles(string? cursor, int? limit, HttpContext ctx,
        Database db, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        if (cursor is not (null or "default"))
            Secrets.Identifier(cursor);
        var take = Page<ProfileView>.Size(limit);
        var rows = await db.List<ProfileRecord>("SELECT * FROM Profiles WHERE Id>@after ORDER BY Id LIMIT @size",
            new { after = cursor ?? "", size = take + 1 }, ct);
        return TypedResults.Ok(Page<ProfileView>.From(rows.Select(x => x.View).ToArray(), take, x => x.Id));
    }

    private static async Task<Created<ProfileView>> CreateProfile(ProfileInput body, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var input = Profile(body);
        var row = new ProfileRecord(Secrets.Id(), input.Name, Wire.Encode(input.Settings), 1);
        if (!await db.Mutate("INSERT OR IGNORE INTO Profiles VALUES(@Id,@Name,@Settings,@Revision)", row, review.Initiator,
            null, "profile.created", new { row.Id }, ct))
            throw Fault.Conflict("profile_name_in_use");
        return TypedResults.Created($"/api/v1/collection-profiles/{row.Id}", row.View);
    }

    private static async Task<Ok<ProfileView>> GetProfile(string id, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var row = await db.One<ProfileRecord>("SELECT * FROM Profiles WHERE Id=@id", new { id }, ct) ?? throw Fault.Missing();
        return TypedResults.Ok(row.View);
    }

    private static async Task<Ok<ProfileView>> UpdateProfile(string id, ProfileInput body, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var input = Profile(body);
        var changed = await db.Mutate("""
            UPDATE OR IGNORE Profiles SET Name=@Name,Settings=@Settings,Revision=Revision+1 WHERE Id=@id AND Revision=@Revision
            """, new { id, input.Name, Settings = Wire.Encode(input.Settings), body.Revision },
            review.Initiator, null, "profile.updated", new { id }, ct);
        if (!changed)
            throw Fault.Conflict("profile_conflict");
        return TypedResults.Ok(new ProfileView(id, input.Name, input.Settings, body.Revision!.Value + 1));
    }

    private static async Task<NoContent> DeleteProfile(string id, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        if (!await db.Mutate("""
            DELETE FROM Profiles WHERE Id=@id AND Id<>'default' AND NOT EXISTS(SELECT 1 FROM Devices WHERE ProfileId=@id)
            """, new { id }, review.Initiator, null, "profile.deleted", new { id }, ct))
            throw Fault.Conflict("profile_in_use_or_missing");
        return TypedResults.NoContent();
    }

    private static ProfileInput Profile(ProfileInput body)
    {
        if (body.Settings is null)
            throw Fault.Bad("invalid_profile");
        body.Settings.Validate();
        return body with { Name = Secrets.Text(body.Name) };
    }

    private static async Task<Ok<IReadOnlyList<LocalRoot>>> LocalRoots(string id, HttpContext ctx, Database db, ReviewService reviews,
        DeviceService devices, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        return TypedResults.Ok(await db.List<LocalRoot>("SELECT RootKey,Label,Writable,[Primary] FROM ObservedRoots WHERE DeviceId=@id ORDER BY Label",
            new { id }, ct));
    }

    private static async Task<Ok<Page<RootInfo>>> ListRoots(string id, string? cursor, int? limit, HttpContext ctx, Database db, ReviewService reviews,
        DeviceService devices, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        var take = Page<RootInfo>.Size(limit);
        var rows = await db.List<RootInfo>("SELECT * FROM Roots WHERE DeviceId=@id AND Id>@after ORDER BY Id LIMIT @size",
            new { id, after = Page<RootInfo>.After(cursor), size = take + 1 }, ct);
        return TypedResults.Ok(Page<RootInfo>.From(rows, take, x => x.Id));
    }

    private static async Task<Created<RootInfo>> CreateRoot(string id, RootInput body, HttpContext ctx, Database db, ReviewService reviews,
        DeviceService devices, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        var root = new RootInfo(Secrets.Id(), id, Secrets.Identifier(body.RootKey), Secrets.Text(body.Label), body.Writable, body.Enabled, 1);
        var changed = await db.Mutate("""
            INSERT OR IGNORE INTO Roots
            SELECT @Id,@DeviceId,@RootKey,@Label,@Writable,@Enabled,1
            WHERE EXISTS(SELECT 1 FROM ObservedRoots WHERE DeviceId=@DeviceId AND RootKey=@RootKey AND (@Writable=0 OR Writable=1))
            """, root, review.Initiator, id, "root.created", new { root.Id }, ct);
        if (!changed)
            throw Fault.Conflict("local_root_unavailable_or_duplicate");
        return TypedResults.Created($"/api/v1/devices/{id}/file-roots/{root.Id}", root);
    }

    private static async Task<Ok<RootInfo>> GetRoot(string id, string rootId, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var root = await db.One<RootInfo>("SELECT * FROM Roots WHERE DeviceId=@id AND Id=@rootId",
            new { id = Secrets.Identifier(id), rootId = Secrets.Identifier(rootId) }, ct) ?? throw Fault.Missing();
        return TypedResults.Ok(root);
    }

    private static async Task<Ok<RootInfo>> UpdateRoot(string id, string rootId, RootInput body, HttpContext ctx,
        Database db, ReviewService reviews, DeviceService devices, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        Secrets.Identifier(rootId);
        var label = Secrets.Text(body.Label);
        if (!await db.Mutate("""
            UPDATE Roots SET Label=@label,Writable=@Writable,Enabled=@Enabled,Revision=Revision+1
            WHERE DeviceId=@id AND Id=@rootId AND Revision=@Revision AND RootKey=@RootKey AND EXISTS(
                SELECT 1 FROM ObservedRoots WHERE DeviceId=@id AND RootKey=@RootKey AND (@Writable=0 OR Writable=1))
            """, new { id, rootId, label, body.Writable, body.Enabled, body.RootKey, body.Revision },
            review.Initiator, id, "root.updated", new { rootId }, ct,
            body.Enabled ? null : (connection, tx, token) => NotificationDeliveries.CancelForSource(connection, tx, id, rootId, token)))
            throw Fault.Conflict("root_conflict");
        return TypedResults.Ok(new RootInfo(rootId, id, body.RootKey, label, body.Writable, body.Enabled, body.Revision!.Value + 1));
    }

    private static async Task<NoContent> DeleteRoot(string id, string rootId, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        if (!await db.Mutate("DELETE FROM Roots WHERE Id=@rootId AND DeviceId=@id",
            new { id = Secrets.Identifier(id), rootId = Secrets.Identifier(rootId) }, review.Initiator, id, "root.revoked", new { rootId }, ct,
            (connection, tx, token) => NotificationDeliveries.CancelForSource(connection, tx, id, rootId, token)))
            throw Fault.Missing();
        return TypedResults.NoContent();
    }

    private static async Task<Ok<Page<AuditView>>> ListAudit(string? cursor, string? deviceId, string? action, int? limit,
        HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var take = Page<AuditView>.Size(limit);
        var rows = await db.List<AuditRecord>("""
            SELECT * FROM Audit WHERE Sequence<@before AND (@deviceId IS NULL OR DeviceId=@deviceId) AND (@action IS NULL OR Action=@action)
            ORDER BY Sequence DESC LIMIT @size
            """, new { before = cursor is null ? long.MaxValue : EventFeed.Cursor(cursor), deviceId, action, size = take + 1 }, ct);
        return TypedResults.Ok(Page<AuditView>.From(rows.Select(x => x.View).ToArray(), take, x => x.Sequence));
    }
}
