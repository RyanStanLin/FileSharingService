using Dapper;
using Microsoft.AspNetCore.Identity;

namespace FileSharing;

internal sealed record FtpAccount(string Id, string Name, string Mode, bool Disabled, long Revision, IReadOnlyList<string> RootIds);
internal sealed record FtpAccountRecord(string Id, string Name, string Mode, long Disabled, long Revision);
internal sealed record FtpAccountInput(string Name, string Mode, IReadOnlyList<string> RootIds, string? Password);
internal sealed record FtpAccountUpdate(string Name, bool Disabled, long Revision, IReadOnlyList<string> RootIds);
internal sealed record FtpPasswordInput(long Revision, string? Password);
internal sealed record FtpCredential(FtpAccount Account, string Password, IReadOnlyList<FtpEndpoint> Endpoints);
internal sealed record FtpIdentity(string Id, string Mode, long Revision);
internal sealed record FtpAuthRecord(string Id, string SecretHash, long Revision, long LockUntil);

internal sealed class FtpAccounts(Database db, FtpSettings settings, IPasswordHasher<FtpAccounts> hasher)
{
    private readonly string dummy = hasher.HashPassword(null!, Secrets.New());

    public async Task<FtpIdentity?> Login(string name, string password, string mode, CancellationToken ct)
    {
        if (name.Length is < 1 or > 64 || password.Length is < 1 or > 128)
            return null;
        var row = await db.One<FtpAuthRecord>("""
            SELECT Id,SecretHash,Revision,LockUntil FROM FtpAccounts WHERE Name=@name AND Mode=@mode AND Disabled=0
            """, new { name, mode }, ct);
        if (row?.LockUntil > Clock.Now)
            return null;
        var valid = hasher.VerifyHashedPassword(this, row?.SecretHash ?? dummy, password) != PasswordVerificationResult.Failed;
        if (row is null)
            return null;
        if (!valid)
        {
            await db.Execute("""
                UPDATE FtpAccounts SET Failed=CASE WHEN LockUntil>0 AND LockUntil<=@now THEN 1 ELSE Failed+1 END,
                LockUntil=CASE WHEN Failed>=4 AND LockUntil=0 THEN @now+900 ELSE 0 END WHERE Id=@Id AND Revision=@Revision AND LockUntil<=@now
                """, new { row.Id, row.Revision, now = Clock.Now }, ct);
            return null;
        }
        var cleared = await db.Mutate("""
            UPDATE FtpAccounts SET Failed=0,LockUntil=0 WHERE Id=@Id AND Revision=@Revision AND Disabled=0 AND LockUntil<=@now
            """, new { row.Id, row.Revision, now = Clock.Now }, row.Id, null, "ftp.login", new { mode }, ct);
        return cleared ? new(row.Id, mode, row.Revision) : null;
    }

    public async Task<bool> Active(FtpIdentity id, CancellationToken ct) =>
        await db.One<int>("SELECT EXISTS(SELECT 1 FROM FtpAccounts WHERE Id=@Id AND Revision=@Revision AND Mode=@Mode AND Disabled=0)", id, ct) == 1;

    public async Task<FtpAccount> Get(string id, string owner, CancellationToken ct)
    {
        var row = await db.One<FtpAccountRecord>("SELECT Id,Name,Mode,Disabled,Revision FROM FtpAccounts WHERE Id=@id AND Owner=@owner",
            new { id = Secrets.Identifier(id), owner }, ct) ?? throw Fault.Missing("ftp_account_not_found");
        return await View(row, ct);
    }

    public async Task<Page<FtpAccount>> List(string owner, string? cursor, int? limit, CancellationToken ct)
    {
        var take = Page<FtpAccount>.Size(limit);
        var rows = await db.List<FtpAccountRecord>("""
            SELECT Id,Name,Mode,Disabled,Revision FROM FtpAccounts WHERE Owner=@owner AND Id>@after ORDER BY Id LIMIT @size
            """, new { owner, after = Page<FtpAccount>.After(cursor), size = take + 1 }, ct);
        var views = new List<FtpAccount>(rows.Count);
        foreach (var row in rows)
            views.Add(await View(row, ct));
        return Page<FtpAccount>.From(views, take, entry => entry.Id);
    }

    private async Task<FtpAccount> View(FtpAccountRecord row, CancellationToken ct) =>
        new(row.Id, row.Name, row.Mode, row.Disabled != 0, row.Revision,
            await db.List<string>("SELECT RootId FROM FtpGrants WHERE AccountId=@Id ORDER BY RootId", row, ct));

    public async Task<FtpCredential> Create(string actor, FtpAccountInput body, CancellationToken ct)
    {
        var name = Name(body.Name);
        var mode = body.Mode is "ftp" or "ftps" ? body.Mode : throw Fault.Bad("invalid_ftp_mode");
        var endpoints = Endpoints(mode);
        if (endpoints.Length == 0)
            throw Fault.Conflict("ftp_mode_disabled");
        var roots = Roots(body.RootIds);
        var password = Password(body.Password);
        var hash = hasher.HashPassword(this, password);
        var id = Secrets.Id();
        await db.Write(async (connection, tx) =>
        {
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO FtpAccounts(Id,Name,Owner,Mode,SecretHash) VALUES(@id,@name,@actor,@mode,@hash)
                """, new { id, name, actor, mode, hash }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("account_name_in_use");
            await SetGrants(connection, tx, id, roots, ct);
            await Audit(connection, tx, actor, id, "ftp.created", ct);
            return true;
        });
        return new(new(id, name, mode, false, 1, roots), password, endpoints);
    }

    public async Task<FtpAccount> Update(string id, string actor, FtpAccountUpdate body, CancellationToken ct)
    {
        var name = Name(body.Name);
        var roots = Roots(body.RootIds);
        var account = await Get(id, actor, ct);
        await db.Write(async (connection, tx) =>
        {
            var reserved = await connection.QuerySingleAsync<int>(new CommandDefinition("""
                SELECT EXISTS(SELECT 1 FROM FtpAccounts WHERE Name=@name AND Id<>@id)
                """, new { name, id }, tx, cancellationToken: ct));
            if (reserved == 1)
                throw Fault.Conflict("account_name_in_use");
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE FtpAccounts SET Name=@name,Disabled=@Disabled,Revision=Revision+1 WHERE Id=@id AND Owner=@actor AND Revision=@Revision
                """, new { id, actor, name, body.Disabled, body.Revision }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("revision_conflict");
            await SetGrants(connection, tx, id, roots, ct);
            await Audit(connection, tx, actor, id, "ftp.updated", ct);
            return true;
        });
        return account with { Name = name, Disabled = body.Disabled, Revision = body.Revision + 1, RootIds = roots };
    }

    public async Task<FtpCredential> Rotate(string id, string actor, FtpPasswordInput body, CancellationToken ct)
    {
        var account = await Get(id, actor, ct);
        var password = Password(body.Password);
        var hash = hasher.HashPassword(this, password);
        if (!await db.Mutate("""
            UPDATE FtpAccounts SET SecretHash=@hash,Failed=0,LockUntil=0,Revision=Revision+1 WHERE Id=@id AND Owner=@actor AND Revision=@Revision
            """, new { id, actor, hash, body.Revision }, actor, null, "ftp.password_rotated", new { id }, ct))
            throw Fault.Conflict("revision_conflict");
        return new(account with { Revision = body.Revision + 1 }, password, Endpoints(account.Mode));
    }

    public async Task Delete(string id, string actor, CancellationToken ct)
    {
        if (!await db.Mutate("DELETE FROM FtpAccounts WHERE Id=@id AND Owner=@actor", new { id = Secrets.Identifier(id), actor },
            actor, null, "ftp.deleted", new { id }, ct))
            throw Fault.Missing("ftp_account_not_found");
    }

    private FtpEndpoint[] Endpoints(string mode) => settings.Endpoints().Where(entry => (entry.Mode == "plain") == (mode == "ftp")).ToArray();

    private static string Name(string? input)
    {
        var value = Secrets.Text(input, 64);
        if (!value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.'))
            throw Fault.Bad("invalid_account_name");
        return value;
    }

    private static string Password(string? value)
    {
        if (value is null)
            return Secrets.New();
        if (value.Length is < 16 or > 128 || value.Any(c => c is < '!' or > '~') ||
            value.Distinct().Count() < 8 || !value.Any(char.IsAsciiLetter) || !value.Any(c => !char.IsAsciiLetter(c)))
            throw Fault.Bad("invalid_ftp_password");
        return value;
    }

    private static string[] Roots(IReadOnlyList<string>? rootIds) => rootIds is { Count: >= 1 and <= 64 }
        ? rootIds.Select(Secrets.Identifier).Distinct().Order(StringComparer.Ordinal).ToArray() : throw Fault.Bad("ftp_roots_required");

    private static async Task SetGrants(System.Data.IDbConnection connection, System.Data.IDbTransaction tx, string id,
        string[] roots, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition("DELETE FROM FtpGrants WHERE AccountId=@id", new { id }, tx, cancellationToken: ct));
        foreach (var root in roots)
        {
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT INTO FtpGrants SELECT @id, r.Id FROM Roots r JOIN Devices d ON d.Id=r.DeviceId
                WHERE r.Id=@root AND r.Enabled=1 AND d.Revoked IS NULL
                """, new { id, root }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("ftp_root_unavailable");
        }
    }

    private static Task Audit(System.Data.IDbConnection connection, System.Data.IDbTransaction tx, string actor,
        string id, string action, CancellationToken ct) => connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO Audit(At,Actor,Action,Detail) VALUES(@now,@actor,@action,@detail)
            """, new { now = Clock.Now, actor, action, detail = Wire.Encode(new { id }) }, tx, cancellationToken: ct));
}

internal static class FtpEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var group = api.MapGroup("/ftp").WithTags("FTP and FTPS");
        group.MapGet("/connection", async (HttpContext ctx, FtpSettings settings, ReviewService sessions, CancellationToken ct) =>
        {
            await sessions.Require(ctx, ct);
            return TypedResults.Ok(settings.Endpoints());
        }).WithSummary("Get configured FTP and FTPS connection addresses");
        group.MapGet("/accounts", async (string? cursor, int? limit, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.List((await sessions.Require(ctx, ct)).Initiator, cursor, limit, ct))).WithSummary("List FTP and FTPS accounts");
        group.MapPost("/accounts", async (FtpAccountInput body, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
        {
            var result = await accounts.Create((await sessions.Require(ctx, ct)).Initiator, body, ct);
            return TypedResults.Created($"/api/v1/ftp/accounts/{result.Account.Id}", result);
        }).WithSummary("Create an FTP or FTPS account and issue its password");
        group.MapGet("/accounts/{id}", async (string id, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Get(id, (await sessions.Require(ctx, ct)).Initiator, ct))).WithSummary("Get one gateway account");
        group.MapPut("/accounts/{id}", async (string id, FtpAccountUpdate body, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Update(id, (await sessions.Require(ctx, ct)).Initiator, body, ct))).WithSummary("Change the username, scope or enabled state");
        group.MapPut("/accounts/{id}/password", async (string id, FtpPasswordInput body,
            HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Rotate(id, (await sessions.Require(ctx, ct)).Initiator, body, ct))).WithSummary("Change the password and revoke current FTP connections");
        group.MapDelete("/accounts/{id}", async (string id, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
        {
            await accounts.Delete(id, (await sessions.Require(ctx, ct)).Initiator, ct);
            return TypedResults.NoContent();
        }).WithSummary("Delete an FTP or FTPS account");
    }
}
