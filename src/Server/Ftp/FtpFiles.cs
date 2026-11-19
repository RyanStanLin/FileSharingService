using Dapper;
using System.Text;

namespace FileSharing;

internal sealed record FtpRoot(string Id, string DeviceId, long Created, string DeviceName, string? Mount)
{
    public FtpRoot() : this("", "", 0, "", null) { }
}
internal sealed record FtpPath(string Device, string Root, string Relative, string? ConnectionId = null);

internal sealed class FtpFiles(Database db, AgentBroker broker, FtpAccounts accounts, FileService files)
{
    internal async Task<FileEntry> Stat(FtpIdentity identity, string path, CancellationToken ct)
    {
        var address = await Address(identity, path, ct);
        if (address.Root.Length > 0)
            return await files.StatGranted(await Scope(identity, address, ct), address.Relative, ct);
        var roots = await Roots(identity, ct);
        if (address.Device.Length > 0 && !roots.Any(root => root.DeviceId == address.Device))
            throw Fault.Missing();
        return Virtual(address.Device, Clock.Now);
    }

    internal async IAsyncEnumerable<FileEntry> List(FtpIdentity identity, string path,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var address = await Address(identity, path, ct);
        if (address.Root.Length == 0)
        {
            var roots = await Roots(identity, ct);
            if (address.Device.Length == 0)
            {
                foreach (var root in roots.DistinctBy(root => root.DeviceId))
                    yield return Virtual(root.Mount ?? root.DeviceId, root.Created);
                yield break;
            }
            var grants = roots.Where(root => root.DeviceId == address.Device).ToArray();
            if (grants.Length == 0)
                throw Fault.Missing();
            foreach (var root in grants)
                yield return Virtual(root.Id, root.Created);
            yield break;
        }

        string? revision = null;
        int? offset = 0;
        while (offset is { } current)
        {
            var root = await Scope(identity, address, ct);
            address = address with { ConnectionId = root.ConnectionId };
            if (address.Relative.Length > 0 && current == 0)
            {
                var entry = await files.StatGranted(root, address.Relative, ct);
                if (entry.Kind != "directory")
                {
                    yield return entry;
                    yield break;
                }
            }
            var page = await files.ListGranted(root, address.Relative, true, current, 200, revision, ct);
            foreach (var entry in page.Items)
                yield return entry;
            revision = page.Revision;
            offset = page.NextOffset;
        }
    }

    internal async Task<(FtpPath Path, FileEntry Entry)> Prepare(FtpIdentity identity, string path, long offset, CancellationToken ct)
    {
        var address = await Address(identity, path, ct);
        var root = await Scope(identity, address, ct);
        var info = await files.StatGranted(root, address.Relative, ct);
        if (info.Kind != "file" || offset > info.Size)
            throw Fault.Conflict("invalid_restart_marker");
        if (offset > 0)
        {
            var version = await db.One<string>("""
                SELECT Version FROM FtpResumes WHERE AccountId=@Id AND Path=@path AND Updated>@old
                """, new { identity.Id, path, old = Clock.Now - 86400 }, ct);
            if (version is not null && version != info.Version)
                throw Fault.Conflict("source_changed");
        }
        await db.Write(async (connection, tx) =>
        {
            var current = new { identity.Id, identity.Revision, path, info.Version, now = Clock.Now };
            var written = await Dapper.SqlMapper.ExecuteAsync(connection, new Dapper.CommandDefinition("""
                INSERT INTO FtpResumes(AccountId,Path,Version,Updated)
                SELECT @Id,@path,@Version,@now WHERE EXISTS(SELECT 1 FROM FtpAccounts WHERE Id=@Id AND Revision=@Revision AND Disabled=0)
                ON CONFLICT(AccountId,Path) DO UPDATE SET Version=excluded.Version,Updated=excluded.Updated
                """, current, tx, cancellationToken: ct));
            if (written == 0)
                throw Fault.Unauthorized();
            return true;
        });
        await db.Audit("ftp.download", identity.Id, root.DeviceId, new { rootId = root.Id, path = address.Relative, offset }, ct);
        return (address with { ConnectionId = root.ConnectionId }, info);
    }

    internal Task Download(FtpIdentity identity, FtpPath path, FileEntry info, long offset, Stream output, CancellationToken ct) =>
        files.Pump(path.Relative, info.Version, offset, info.Size - offset, output, token => Scope(identity, path, token), null, ct);

    private async Task<IReadOnlyList<FtpRoot>> Roots(FtpIdentity identity, CancellationToken ct)
    {
        if (!await accounts.Active(identity, ct))
            throw Fault.Unauthorized();
        var rows = await db.List<FtpRoot>(RootSelection + " ORDER BY r.DeviceId,r.Id", identity, ct);
        var visible = rows.Where(row => broker.Presence(row.DeviceId).AccessGranted).ToArray();
        if (identity.Scope == "activeHomes" && visible.Any(row => row.Mount is null))
        {
            return await db.Write(async (connection, tx) =>
            {
                for (var i = 0; i < visible.Length; i++)
                {
                    var row = visible[i];
                    if (row.Mount is not null)
                        continue;
                    var name = MountName(row.DeviceName);
                    await connection.ExecuteAsync(new CommandDefinition("""
                        INSERT OR IGNORE INTO GatewayMounts VALUES(@DeviceId,@name);
                        INSERT OR IGNORE INTO GatewayMounts VALUES(@DeviceId,@fallback);
                        """, new { row.DeviceId, name, fallback = name + "~" + row.DeviceId }, tx, cancellationToken: ct));
                    var mount = await connection.QuerySingleAsync<string>(new CommandDefinition(
                        "SELECT Name FROM GatewayMounts WHERE DeviceId=@DeviceId", row, tx, cancellationToken: ct));
                    visible[i] = row with { Mount = mount };
                }
                return visible;
            });
        }
        return visible;
    }

    private async Task<RootInfo> Scope(FtpIdentity identity, FtpPath path, CancellationToken ct)
    {
        if (path.Device.Length == 0 || path.Root.Length == 0)
            throw Fault.Missing();
        var connection = broker.RequireAccess(path.Device, path.ConnectionId);
        var root = await db.One<RootInfo>("""
            SELECT r.* FROM Roots r JOIN Devices d ON d.Id=r.DeviceId
            JOIN ObservedRoots o ON o.DeviceId=d.Id AND o.RootKey=r.RootKey
            JOIN FtpAccounts a ON a.Id=@Id AND a.Revision=@Revision AND a.Disabled=0 AND a.Scope=@Scope
            LEFT JOIN FtpGrants g ON g.RootId=r.Id AND g.AccountId=a.Id
            WHERE r.DeviceId=@Device AND r.Id=@Root AND r.Enabled=1 AND d.Revoked IS NULL
                AND ((a.Scope='activeHomes' AND o.[Primary]=1) OR (a.Scope='grants' AND g.RootId IS NOT NULL))
            """, new { identity.Id, identity.Revision, identity.Scope, path.Device, path.Root }, ct) ?? throw Fault.Forbidden("root_access_denied");
        return root with { ConnectionId = connection };
    }

    internal static FileEntry Virtual(string name, long created) =>
        new(name, name, name, "directory", 0, Clock.At(created), Clock.At(created), 0, 365, "", false);

    private async Task<FtpPath> Address(FtpIdentity identity, string path, CancellationToken ct)
    {
        var clean = FileService.PathKey(path.TrimStart('/'));
        if (clean.Length == 0)
            return new("", "", "");
        if (identity.Scope == "grants")
        {
            var parts = clean.Split('/', 3);
            return new(Secrets.Identifier(parts[0]), parts.Length > 1 ? Secrets.Identifier(parts[1]) : "",
                parts.Length > 2 ? parts[2] : "");
        }

        var home = clean.Split('/', 2);
        var row = await db.One<FtpRoot>(RootSelection + " AND m.Name=@name",
            new { identity.Id, identity.Revision, identity.Scope, name = home[0] }, ct);
        row ??= (await Roots(identity, ct)).FirstOrDefault(item => string.Equals(item.Mount, home[0], StringComparison.OrdinalIgnoreCase));
        if (row is null)
            throw Fault.Missing();
        return new(row.DeviceId, row.Id, home.Length > 1 ? home[1] : "");
    }

    private static string MountName(string name)
    {
        var slug = new StringBuilder(48);
        foreach (var character in name)
        {
            if (slug.Length >= 48)
                break;
            if (char.IsAsciiLetterOrDigit(character))
                slug.Append(char.ToLowerInvariant(character));
            else if (slug.Length > 0 && slug[^1] != '-')
                slug.Append('-');
        }
        return slug.Length == 0 ? "mac" : slug.ToString().TrimEnd('-');
    }

    private const string RootSelection = """
        SELECT r.Id,r.DeviceId,d.Created,d.Name AS DeviceName,CASE WHEN a.Scope='activeHomes' THEN m.Name END AS Mount
        FROM Roots r JOIN Devices d ON d.Id=r.DeviceId
        JOIN ObservedRoots o ON o.DeviceId=d.Id AND o.RootKey=r.RootKey
        JOIN FtpAccounts a ON a.Id=@Id AND a.Revision=@Revision AND a.Scope=@Scope AND a.Disabled=0
        LEFT JOIN FtpGrants g ON g.RootId=r.Id AND g.AccountId=a.Id
        LEFT JOIN GatewayMounts m ON m.DeviceId=r.DeviceId
        WHERE r.Enabled=1 AND d.Revoked IS NULL
            AND ((a.Scope='activeHomes' AND o.[Primary]=1) OR (a.Scope='grants' AND g.RootId IS NOT NULL))
        """;
}
