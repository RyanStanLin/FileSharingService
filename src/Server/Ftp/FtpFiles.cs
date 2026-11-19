namespace FileSharing;

internal sealed record FtpRoot(string Id, string DeviceId, long Created);
internal sealed record FtpPath(string Device, string Root, string Relative, string? ConnectionId = null);

internal sealed class FtpFiles(Database db, AgentBroker broker, FtpAccounts accounts, FileService files)
{
    internal async Task<FileEntry> Stat(FtpIdentity identity, string path, CancellationToken ct)
    {
        var address = Parse(path);
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
        var address = Parse(path);
        if (address.Root.Length == 0)
        {
            var roots = await Roots(identity, ct);
            if (address.Device.Length == 0)
            {
                foreach (var root in roots.DistinctBy(root => root.DeviceId))
                    yield return Virtual(root.DeviceId, root.Created);
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
        var address = Parse(path);
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
        var rows = await db.List<FtpRoot>("""
            SELECT r.Id,r.DeviceId,d.Created FROM FtpGrants g JOIN Roots r ON r.Id=g.RootId
            JOIN Devices d ON d.Id=r.DeviceId JOIN ObservedRoots o ON o.DeviceId=d.Id AND o.RootKey=r.RootKey
            JOIN FtpAccounts a ON a.Id=g.AccountId
            WHERE a.Id=@Id AND a.Revision=@Revision AND a.Disabled=0 AND r.Enabled=1 AND d.Revoked IS NULL
            ORDER BY r.DeviceId,r.Id
            """, identity, ct);
        return rows.Where(row => broker.Presence(row.DeviceId).AccessGranted).ToArray();
    }

    private async Task<RootInfo> Scope(FtpIdentity identity, FtpPath path, CancellationToken ct)
    {
        if (path.Device.Length == 0 || path.Root.Length == 0)
            throw Fault.Missing();
        var connection = broker.RequireAccess(path.Device, path.ConnectionId);
        var root = await db.One<RootInfo>("""
            SELECT r.* FROM FtpGrants g JOIN Roots r ON r.Id=g.RootId JOIN FtpAccounts a ON a.Id=g.AccountId
            JOIN Devices d ON d.Id=r.DeviceId JOIN ObservedRoots o ON o.DeviceId=d.Id AND o.RootKey=r.RootKey
            WHERE a.Id=@Id AND a.Revision=@Revision AND a.Disabled=0 AND r.DeviceId=@Device AND r.Id=@Root AND r.Enabled=1 AND d.Revoked IS NULL
            """, new { identity.Id, identity.Revision, path.Device, path.Root }, ct) ?? throw Fault.Forbidden("root_access_denied");
        return root with { ConnectionId = connection };
    }

    internal static FileEntry Virtual(string name, long created) =>
        new(name, name, name, "directory", 0, Clock.At(created), Clock.At(created), 0, 365, "", false);

    private static FtpPath Parse(string path)
    {
        var parts = path.TrimStart('/').Split('/', 3);
        return new(parts[0].Length > 0 ? Secrets.Identifier(parts[0]) : "",
            parts.Length > 1 ? Secrets.Identifier(parts[1]) : "",
            parts.Length > 2 ? FileService.PathKey(parts[2]) : "");
    }
}
