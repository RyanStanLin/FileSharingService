using Dapper;
using Microsoft.AspNetCore.Identity;

namespace FileSharing;

internal sealed record Review(string Id, string Initiator, long Created, long Expires, long LastAccess)
{
    public ReviewResponse View => new(Id, Clock.At(Created), Clock.At(Expires));
}

internal sealed record ReviewResponse(string Id, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt);
internal sealed record Challenge(string Owner, string State);

internal sealed class ReviewService(Database db, Settings settings)
{
    private const string Active = """
        FROM Reviews r WHERE r.Revoked IS NULL AND r.Expires>@Now AND r.LastAccess>@Idle
        """;

    public static void RequireOrigin(HttpContext context, Settings settings)
    {
        if (!string.Equals(context.Request.Headers.Origin, settings.OriginValue, StringComparison.Ordinal))
            throw Fault.Forbidden("invalid_origin");
    }

    public async Task ReplacePasskey(string actor, long revision, UserPasskeyInfo passkey, CancellationToken ct)
    {
        await db.Write(async (connection, tx) =>
        {
            var changed = await connection.ExecuteAsync(new CommandDefinition(
                "UPDATE Operators SET Revision=Revision+1 WHERE Id=@actor AND Revision=@revision",
                new { actor, revision }, tx, cancellationToken: ct));
            if (changed != 1)
                throw Fault.Conflict("passkey_configuration_changed");
            await connection.ExecuteAsync(new CommandDefinition("""
                DELETE FROM Passkeys WHERE OperatorId=@actor;
                INSERT INTO Passkeys(CredentialId,OperatorId,Data) VALUES(@CredentialId,@actor,@data);
                UPDATE Reviews SET Revoked=@now WHERE Initiator=@actor AND Revoked IS NULL;
                INSERT INTO Audit(At,Actor,Action,Detail) VALUES(@now,@actor,@action,'{}');
                """, new { actor, passkey.CredentialId, data = Wire.Encode(passkey), now = Clock.Now,
                    action = revision == 0 ? "passkey.registered" : "passkey.recovered" }, tx, cancellationToken: ct));
            return true;
        });
    }

    public async Task<Review> Start(HttpContext context, string actor, long revision, UserPasskeyInfo passkey, CancellationToken ct)
    {
        var token = Secrets.New();
        var now = Clock.Now;
        var id = Secrets.Id();
        var expires = now + 28800;
        var previous = context.Request.Cookies[settings.Cookie];
        await db.Write(async (connection, tx) =>
        {
            var saved = await connection.QuerySingleOrDefaultAsync<string>(new CommandDefinition("""
                SELECT p.Data FROM Passkeys p JOIN Operators o ON p.OperatorId=o.Id
                WHERE CredentialId=@CredentialId AND OperatorId=@actor AND o.Revision=@revision
                """, new { passkey.CredentialId, actor, revision }, tx, cancellationToken: ct));
            if (saved is null)
                throw Fault.Unauthorized();
            var previousKey = Wire.Model<UserPasskeyInfo>(Wire.Parse(saved));
            if (previousKey.SignCount > 0 && passkey.SignCount <= previousKey.SignCount)
                throw Fault.Unauthorized();

            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE Passkeys SET Data=@data WHERE CredentialId=@CredentialId;
                UPDATE Reviews SET Revoked=@now WHERE SecretHash=@old AND Initiator=@actor AND Revoked IS NULL;
                INSERT INTO Reviews(Id,SecretHash,Initiator,Created,Expires,LastAccess)
                VALUES(@id,@hash,@actor,@now,@expires,@now);
                INSERT INTO Audit(At,Actor,Action,Detail) VALUES(@now,@actor,'session.unlocked',@detail);
                """, new { id, passkey.CredentialId, data = Wire.Encode(passkey), hash = Secrets.Hash(token),
                    old = previous is { Length: 43 } ? Secrets.Hash(previous) : null,
                    actor, now, expires, detail = Wire.Encode(new { id }) }, tx, cancellationToken: ct));
            return true;
        });
        context.Response.Cookies.Append(settings.Cookie, token, Cookie(TimeSpan.FromHours(8)));
        return new Review(id, actor, now, expires, now);
    }

    public Task<Review?> Current(HttpContext context, CancellationToken ct)
    {
        var token = context.Request.Cookies[settings.Cookie];
        return token is not { Length: 43 } ? Task.FromResult<Review?>(null) : db.One<Review>(
            $"SELECT Id,Initiator,Created,Expires,LastAccess {Active} AND r.SecretHash=@Hash",
            new { Hash = Secrets.Hash(token), Now = Clock.Now, Idle = Clock.Now - 1800 }, ct);
    }

    public async Task<Review> Require(HttpContext context, CancellationToken ct)
    {
        var review = await Current(context, ct) ?? throw Fault.Unauthorized();
        await Touch(review.Id, review.LastAccess, ct);
        return review;
    }

    public Task<Review?> ActiveById(string id, CancellationToken ct) =>
        db.One<Review>($"SELECT Id,Initiator,Created,Expires,LastAccess {Active} AND r.Id=@id",
            new { id, Now = Clock.Now, Idle = Clock.Now - 1800 }, ct);

    public Task Touch(string id, long lastAccess, CancellationToken ct) =>
        Clock.Now - lastAccess < 10 ? Task.CompletedTask :
            db.Execute("UPDATE Reviews SET LastAccess=@Now WHERE Id=@id AND Revoked IS NULL", new { id, Now = Clock.Now }, ct);

    public async Task End(HttpContext context, CancellationToken ct)
    {
        var current = await Current(context, ct);
        if (current is not null)
            await db.Mutate("UPDATE Reviews SET Revoked=@Now WHERE Id=@Id AND Revoked IS NULL",
                new { current.Id, Now = Clock.Now }, current.Initiator, null, "session.locked", new { current.Id }, ct);
        Clear(context);
    }

    public void Clear(HttpContext context) => context.Response.Cookies.Delete(settings.Cookie, Cookie(null));

    private CookieOptions Cookie(TimeSpan? age) => new()
    {
        Secure = settings.Origin.Scheme == "https",
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Path = "/",
        MaxAge = age
    };

    public async Task<string> Challenge(string purpose, string owner, string state, CancellationToken ct)
    {
        var id = Secrets.New();
        await db.Execute("INSERT INTO Challenges VALUES(@Hash,@purpose,@owner,@state,@Expires)",
            new { Hash = Secrets.Hash(id), purpose, owner, state, Expires = Clock.Now + 120 }, ct);
        return id;
    }

    public async Task<Challenge> Consume(string? id, string purpose, CancellationToken ct)
    {
        if (id is not { Length: 43 })
            throw Fault.Unauthorized();
        return await db.One<Challenge>("DELETE FROM Challenges WHERE Hash=@Hash AND Purpose=@purpose AND Expires>@Now RETURNING Owner,State",
            new { Hash = Secrets.Hash(id), purpose, Now = Clock.Now }, ct) ?? throw Fault.Unauthorized();
    }
}
