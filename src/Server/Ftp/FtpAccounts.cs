using Dapper;
using Microsoft.AspNetCore.Identity;

namespace FileSharing;

/// <summary>Gateway account metadata and the effective directory-scope mode.</summary>
internal sealed record FtpAccount(string Id, string Name, string Mode, bool Disabled, long Revision, IReadOnlyList<string> RootIds,
    string Scope, DateTimeOffset? PasswordChangedAt, bool PasswordRetrievable);
internal sealed record FtpAccountRecord(string Id, string Name, string Mode, long Disabled, long Revision, string Scope,
    long? PasswordChanged, long HasCipher)
{
    // An empty SQLite result reports the computed HasCipher column without an integer runtime type.
    public FtpAccountRecord() : this("", "", "", 0, 0, "", null, 0) { }
}
/// <summary>Creates a protocol-specific credential and selects its directory scope.</summary>
internal sealed record FtpAccountInput(string Name, string Mode, IReadOnlyList<string>? RootIds, string? Password, string? Scope = null);
/// <summary>Changes a username, enabled state or directory scope using the current revision.</summary>
internal sealed record FtpAccountUpdate(string Name, bool Disabled, long Revision, IReadOnlyList<string>? RootIds, string? Scope = null);
internal sealed record FtpPasswordInput(long Revision, string? Password);
internal sealed record FtpCredential(FtpAccount Account, string Password, IReadOnlyList<FtpEndpoint> Endpoints);
/// <summary>Username and gateway secret returned by the audited password reveal endpoint.</summary>
internal sealed record FtpRevealedPassword(string Name, string Password);
internal sealed record FtpIdentity(string Id, string Mode, long Revision, string Scope);
internal sealed record FtpAuthRecord(string Id, string SecretHash, long Revision, long LockUntil, string Scope);
internal sealed record FtpPasswordRecord(string Id, string Name, string? SecretCipher);

internal sealed class FtpAccounts(Database db, FtpSettings settings, SftpRuntime sftp, GatewayCredentialVault vault,
    IPasswordHasher<FtpAccounts> hasher)
{
    private readonly string dummy = hasher.HashPassword(null!, Secrets.New());

    public async Task<FtpIdentity?> Login(string name, string password, string mode, CancellationToken ct)
    {
        if (name.Length is < 1 or > 64 || password.Length is < 1 or > 128)
            return null;
        var row = await db.One<FtpAuthRecord>("""
            SELECT Id,SecretHash,Revision,LockUntil,Scope FROM FtpAccounts WHERE Name=@name AND Mode=@mode AND Disabled=0
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
        return cleared ? new(row.Id, mode, row.Revision, row.Scope) : null;
    }

    public async Task<bool> Active(FtpIdentity id, CancellationToken ct) =>
        await db.One<int>("SELECT EXISTS(SELECT 1 FROM FtpAccounts WHERE Id=@Id AND Revision=@Revision AND Mode=@Mode AND Scope=@Scope AND Disabled=0)", id, ct) == 1;

    public async Task<IReadOnlySet<string>> OwnedIds(string owner, CancellationToken ct) =>
        (await db.List<string>("SELECT Id FROM FtpAccounts WHERE Owner=@owner", new { owner }, ct)).ToHashSet(StringComparer.Ordinal);

    public async Task<FtpAccount> Get(string id, string owner, CancellationToken ct)
    {
        var row = await db.One<FtpAccountRecord>("""
            SELECT Id,Name,Mode,Disabled,Revision,Scope,PasswordChanged,SecretCipher IS NOT NULL AS HasCipher
            FROM FtpAccounts WHERE Id=@id AND Owner=@owner
            """,
            new { id = Secrets.Identifier(id), owner }, ct) ?? throw Fault.Missing("ftp_account_not_found");
        return await View(row, ct);
    }

    public async Task<Page<FtpAccount>> List(string owner, string? cursor, int? limit, CancellationToken ct)
    {
        var take = Page<FtpAccount>.Size(limit);
        var rows = await db.List<FtpAccountRecord>("""
            SELECT Id,Name,Mode,Disabled,Revision,Scope,PasswordChanged,SecretCipher IS NOT NULL AS HasCipher
            FROM FtpAccounts WHERE Owner=@owner AND Id>@after ORDER BY Id LIMIT @size
            """, new { owner, after = Page<FtpAccount>.After(cursor), size = take + 1 }, ct);
        var views = new List<FtpAccount>(rows.Count);
        foreach (var row in rows)
            views.Add(await View(row, ct));
        return Page<FtpAccount>.From(views, take, entry => entry.Id);
    }

    private async Task<FtpAccount> View(FtpAccountRecord row, CancellationToken ct) =>
        new(row.Id, row.Name, row.Mode, row.Disabled != 0, row.Revision,
            await db.List<string>("SELECT RootId FROM FtpGrants WHERE AccountId=@Id ORDER BY RootId", row, ct),
            row.Scope, row.PasswordChanged is { } at ? Clock.At(at) : null, row.HasCipher != 0 && vault.Enabled);

    public async Task<FtpCredential> Create(string actor, FtpAccountInput body, CancellationToken ct)
    {
        var name = Name(body.Name);
        var mode = body.Mode is "ftp" or "ftps" or "sftp" ? body.Mode : throw Fault.Bad("invalid_ftp_mode");
        var endpoints = Endpoints(mode);
        if (endpoints.Length == 0)
            throw Fault.Conflict("ftp_mode_disabled");
        var (scope, roots) = GrantScope(body.Scope, body.RootIds);
        var password = Password(body.Password);
        var hash = hasher.HashPassword(this, password);
        var id = Secrets.Id();
        var secretCipher = vault.Seal(id, password);
        var changedAt = Clock.Now;
        await db.Write(async (connection, tx) =>
        {
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO FtpAccounts(Id,Name,Owner,Mode,SecretHash,Scope,SecretCipher,PasswordChanged)
                VALUES(@id,@name,@actor,@mode,@hash,@scope,@secretCipher,@changedAt)
                """, new { id, name, actor, mode, hash, scope, secretCipher, changedAt }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("account_name_in_use");
            await SetGrants(connection, tx, id, roots, ct);
            await Audit(connection, tx, actor, id, "ftp.created", ct);
            return true;
        });
        return new(new(id, name, mode, false, 1, roots, scope, Clock.At(changedAt), secretCipher is not null), password, endpoints);
    }

    public async Task<FtpAccount> Update(string id, string actor, FtpAccountUpdate body, CancellationToken ct)
    {
        var name = Name(body.Name);
        var account = await Get(id, actor, ct);
        var (scope, roots) = GrantScope(body.Scope ?? account.Scope, body.RootIds);
        await db.Write(async (connection, tx) =>
        {
            var reserved = await connection.QuerySingleAsync<int>(new CommandDefinition("""
                SELECT EXISTS(SELECT 1 FROM FtpAccounts WHERE Name=@name AND Id<>@id)
                """, new { name, id }, tx, cancellationToken: ct));
            if (reserved == 1)
                throw Fault.Conflict("account_name_in_use");
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE FtpAccounts SET Name=@name,Disabled=@Disabled,Scope=@scope,Revision=Revision+1
                WHERE Id=@id AND Owner=@actor AND Revision=@Revision
                """, new { id, actor, name, scope, body.Disabled, body.Revision }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("revision_conflict");
            await SetGrants(connection, tx, id, roots, ct);
            await Audit(connection, tx, actor, id, "ftp.updated", ct);
            return true;
        });
        return account with { Name = name, Disabled = body.Disabled, Revision = body.Revision + 1, RootIds = roots, Scope = scope };
    }

    public async Task<FtpCredential> Rotate(string id, string actor, FtpPasswordInput body, CancellationToken ct)
    {
        var account = await Get(id, actor, ct);
        var password = Password(body.Password);
        var hash = hasher.HashPassword(this, password);
        var secretCipher = vault.Seal(id, password);
        var changedAt = Clock.Now;
        if (!await db.Mutate("""
            UPDATE FtpAccounts SET SecretHash=@hash,SecretCipher=@secretCipher,PasswordChanged=@changedAt,
                Failed=0,LockUntil=0,Revision=Revision+1 WHERE Id=@id AND Owner=@actor AND Revision=@Revision
            """, new { id, actor, hash, secretCipher, changedAt, body.Revision }, actor, null, "ftp.password_rotated", new { id }, ct))
            throw Fault.Conflict("revision_conflict");
        return new(account with { Revision = body.Revision + 1, PasswordChangedAt = Clock.At(changedAt),
            PasswordRetrievable = secretCipher is not null }, password, Endpoints(account.Mode));
    }

    public Task<FtpRevealedPassword> Reveal(string id, Review review, CancellationToken ct)
    {
        if (Clock.Now - review.Created > 300)
            throw Fault.Forbidden("fresh_passkey_required");
        Secrets.Identifier(id);
        return db.Write(async (connection, tx) =>
        {
            var row = await connection.QuerySingleOrDefaultAsync<FtpPasswordRecord>(new CommandDefinition("""
                SELECT Id,Name,SecretCipher FROM FtpAccounts WHERE Id=@id AND Owner=@Initiator
                """, new { id, review.Initiator }, tx, cancellationToken: ct)) ?? throw Fault.Missing("ftp_account_not_found");
            var password = vault.Reveal(row.Id, row.SecretCipher);
            await Audit(connection, tx, review.Initiator, id, "ftp.password_revealed", ct);
            return new FtpRevealedPassword(row.Name, password);
        });
    }

    public async Task Delete(string id, string actor, CancellationToken ct)
    {
        if (!await db.Mutate("DELETE FROM FtpAccounts WHERE Id=@id AND Owner=@actor", new { id = Secrets.Identifier(id), actor },
            actor, null, "ftp.deleted", new { id }, ct))
            throw Fault.Missing("ftp_account_not_found");
    }

    public FtpEndpoint[] Endpoints(string? mode = null)
    {
        var ftp = settings.Endpoints();
        return mode switch
        {
            null => sftp.Endpoint() is { } endpoint ? [.. ftp, endpoint] : ftp,
            "sftp" => sftp.Endpoint() is { } endpoint ? [endpoint] : [],
            _ => ftp.Where(entry => (entry.Mode == "plain") == (mode == "ftp")).ToArray()
        };
    }

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

    private static (string Scope, string[] Roots) GrantScope(string? scope, IReadOnlyList<string>? rootIds)
    {
        scope ??= rootIds is { Count: > 0 } ? "grants" : "activeHomes";
        return scope switch
        {
            "activeHomes" when rootIds is null or { Count: 0 } => (scope, []),
            "grants" when rootIds is { Count: >= 1 and <= 64 } =>
                (scope, rootIds.Select(Secrets.Identifier).Distinct().Order(StringComparer.Ordinal).ToArray()),
            "grants" => throw Fault.Bad("ftp_roots_required"),
            _ => throw Fault.Bad("invalid_gateway_scope")
        };
    }

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
        var group = api.MapGroup("/ftp").WithTags("FTP, FTPS and SFTP");
        group.MapGet("/connection", async (HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
        {
            await sessions.Require(ctx, ct);
            return TypedResults.Ok(accounts.Endpoints());
        }).WithSummary("Get configured gateway endpoints and the live SFTP host key");
        group.MapGet("/connections", async (string? accountId, HttpContext ctx, GatewaySessions connections, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await connections.List(accountId, (await sessions.Require(ctx, ct)).Initiator, ct)))
            .WithSummary("List live authenticated gateway connections");
        group.MapGet("/accounts", async (string? cursor, int? limit, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.List((await sessions.Require(ctx, ct)).Initiator, cursor, limit, ct))).WithSummary("List gateway accounts");
        group.MapPost("/accounts", async (FtpAccountInput body, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
        {
            var result = await accounts.Create((await sessions.Require(ctx, ct)).Initiator, body, ct);
            return TypedResults.Created($"/api/v1/ftp/accounts/{result.Account.Id}", result);
        }).WithSummary("Create a protocol-specific gateway account and issue its password");
        group.MapGet("/accounts/{id}", async (string id, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Get(id, (await sessions.Require(ctx, ct)).Initiator, ct))).WithSummary("Get one gateway account");
        group.MapPut("/accounts/{id}", async (string id, FtpAccountUpdate body, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Update(id, (await sessions.Require(ctx, ct)).Initiator, body, ct))).WithSummary("Change the username, scope or enabled state");
        group.MapPut("/accounts/{id}/password", async (string id, FtpPasswordInput body,
            HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Rotate(id, (await sessions.Require(ctx, ct)).Initiator, body, ct))).WithSummary("Change the password and revoke current gateway connections");
        group.MapPost("/accounts/{id}/password/reveal", async (string id, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
            TypedResults.Ok(await accounts.Reveal(id, await sessions.Require(ctx, ct), ct)))
            .WithSummary("Reveal an encrypted gateway password with a recent Passkey assertion");
        group.MapDelete("/accounts/{id}", async (string id, HttpContext ctx, FtpAccounts accounts, ReviewService sessions, CancellationToken ct) =>
        {
            await accounts.Delete(id, (await sessions.Require(ctx, ct)).Initiator, ct);
            return TypedResults.NoContent();
        }).WithSummary("Delete a gateway account");
    }
}
