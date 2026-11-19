using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.WebUtilities;

namespace FileSharing;

internal sealed record ActivationRequest(string Code, string Name, string PublicKey);
internal sealed record AgentSessionRequest(string DeviceId, string Challenge, string Signature);
internal sealed record DeviceChallengeRequest(string DeviceId);
internal sealed record ActivationResponse(string DeviceId);
internal sealed record DeviceChallengeResponse(string Challenge);
internal sealed record AgentSessionResponse(string Token, DateTimeOffset ExpiresAt);
internal sealed record ActivationTicket(string Id, string? UsedBy, long? Used);

internal sealed class AgentIdentity(Database db, ReviewService challenges, Settings settings)
{
    public async Task<ActivationResponse> Activate(ActivationRequest body, CancellationToken ct)
    {
        if (body.Code is not { Length: 43 })
            throw Fault.Unauthorized();
        var key = Decode(body.PublicKey, 65);
        var name = Secrets.Text(body.Name);
        using var identity = Open(key);
        var now = Clock.Now;
        return await db.Write(async (connection, tx) =>
        {
            var ticket = await connection.QuerySingleOrDefaultAsync<ActivationTicket>(new CommandDefinition("""
                SELECT Id,UsedBy,Used FROM Activations WHERE SecretHash=@hash AND Expires>@now AND Revoked IS NULL
                """, new { hash = Secrets.Hash(body.Code), now }, tx, cancellationToken: ct));
            if (ticket is null)
                throw Fault.Unauthorized();
            if (ticket.Used is not null)
            {
                var existing = await connection.QuerySingleOrDefaultAsync<string>(new CommandDefinition("""
                    SELECT Id FROM Devices WHERE Id=@UsedBy AND PublicKey=@key AND Revoked IS NULL
                    """, new { ticket.UsedBy, key }, tx, cancellationToken: ct));
                return new ActivationResponse(existing ?? throw Fault.Unauthorized());
            }
            var id = Secrets.Id();
            var created = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO Devices(Id,PublicKey,Name,ProfileId,Created)
                SELECT @id,@key,@name,'default',@now WHERE (SELECT COUNT(*) FROM Devices WHERE Revoked IS NULL)<@MaxDevices
                """, new { id, key, name, now, settings.MaxDevices }, tx, cancellationToken: ct));
            if (created == 0)
                throw Fault.Conflict("device_capacity_or_key_in_use");
            await connection.ExecuteAsync(new CommandDefinition("""
                UPDATE Activations SET Used=@now,UsedBy=@id WHERE Id=@ticketId;
                INSERT INTO Audit(At,DeviceId,Action,Detail) VALUES(@now,@id,'device.activated','{}');
                """, new { now, id, ticketId = ticket.Id }, tx, cancellationToken: ct));
            return new ActivationResponse(id);
        });
    }

    public async Task<DeviceChallengeResponse> Challenge(DeviceChallengeRequest request, CancellationToken ct)
    {
        var id = Secrets.Identifier(request.DeviceId);
        if (await db.One<int>("SELECT EXISTS(SELECT 1 FROM Devices WHERE Id=@id AND Revoked IS NULL)", new { id }, ct) != 1)
            throw Fault.Unauthorized();
        return new(await challenges.Challenge("agent", id, "", ct));
    }

    public async Task<AgentSessionResponse> Authorize(AgentSessionRequest body, CancellationToken ct)
    {
        var id = Secrets.Identifier(body.DeviceId);
        var challenge = await challenges.Consume(body.Challenge, "agent", ct);
        if (challenge.Owner != id)
            throw Fault.Unauthorized();
        var key = await db.One<byte[]>("SELECT PublicKey FROM Devices WHERE Id=@id AND Revoked IS NULL", new { id }, ct);
        if (key is null)
            throw Fault.Unauthorized();
        using var identity = Open(key);
        var signature = Decode(body.Signature, 64);
        var message = Encoding.UTF8.GetBytes($"FileSharing agent session v1\n{id}\n{body.Challenge}");
        if (!identity.VerifyData(message, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw Fault.Unauthorized();

        var token = Secrets.New();
        var expires = Clock.Now + 3600;
        await db.Write(async (connection, tx) =>
        {
            await connection.ExecuteAsync(new CommandDefinition("""
                DELETE FROM AgentTokens WHERE DeviceId=@id;
                INSERT INTO AgentTokens VALUES(@Hash,@id,@expires)
                """, new { Hash = Secrets.Hash(token), id, expires }, tx, cancellationToken: ct));
            return true;
        });
        return new(token, Clock.At(expires));
    }

    public Task<string?> Verify(HttpContext context, CancellationToken ct)
    {
        var header = context.Request.Headers.Authorization.ToString();
        return header is { Length: 50 } && header.StartsWith("Bearer ", StringComparison.Ordinal) ?
            db.One<string>("""
                SELECT t.DeviceId FROM AgentTokens t JOIN Devices d ON d.Id=t.DeviceId
                WHERE t.Hash=@Hash AND t.Expires>@Now AND d.Revoked IS NULL
                """, new { Hash = Secrets.Hash(header[7..]), Now = Clock.Now }, ct) :
            Task.FromResult<string?>(null);
    }

    public async Task<string> Require(HttpContext context, CancellationToken ct) =>
        await Verify(context, ct) ?? throw Fault.Unauthorized();

    private static byte[] Decode(string value, int expected)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 100)
            throw Fault.Bad("invalid_device_proof");
        try
        {
            var bytes = WebEncoders.Base64UrlDecode(value);
            return bytes.Length == expected ? bytes : throw Fault.Bad("invalid_device_proof");
        }
        catch (FormatException)
        {
            throw Fault.Bad("invalid_device_proof");
        }
    }

    private static ECDsa Open(byte[] bytes)
    {
        if (bytes[0] != 4)
            throw Fault.Bad("invalid_device_key");
        try
        {
            return ECDsa.Create(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = bytes[1..33], Y = bytes[33..65] }
            });
        }
        catch (CryptographicException)
        {
            throw Fault.Bad("invalid_device_key");
        }
    }
}
