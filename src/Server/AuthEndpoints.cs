using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;

namespace FileSharing;

internal sealed record SetupRequest(string Secret);
internal sealed record RegistrationRequest(string ChallengeId, JsonElement Credential, string Secret);
internal sealed record CredentialRequest(string ChallengeId, JsonElement Credential);
internal sealed record ChallengeResponse(string ChallengeId, JsonElement PublicKey);
internal sealed record AdminStatus(bool Initialized, bool Unlocked, ReviewResponse? Session);

internal static class AuthEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var auth = api.MapGroup("/auth").WithTags("Passkeys");
        auth.MapGet("/status", Status).WithSummary("Read the current administrator lock status");
        auth.MapPost("/lock", async (HttpContext context, ReviewService sessions, CancellationToken ct) =>
        {
            await sessions.End(context, ct);
            return TypedResults.NoContent();
        }).WithSummary("Lock the administrator session");

        var passkeys = auth.MapGroup("/passkeys").RequireRateLimiting("auth");
        passkeys.MapPost("/registration/options", (SetupRequest body, HttpContext context, Database db,
            IPasskeyHandler<Operator> handler, ReviewService sessions, Settings settings, CancellationToken ct) =>
            RegistrationOptions(body, context, db, handler, sessions, settings, false, ct)).WithSummary("Begin initial passkey registration");
        passkeys.MapPost("/registration", (RegistrationRequest body, HttpContext context, IPasskeyHandler<Operator> handler,
            ReviewService sessions, Settings settings, CancellationToken ct) =>
            Register(body, context, handler, sessions, settings, false, ct)).WithSummary("Register the first administrator passkey");
        passkeys.MapPost("/recovery/options", (SetupRequest body, HttpContext context, Database db,
            IPasskeyHandler<Operator> handler, ReviewService sessions, Settings settings, CancellationToken ct) =>
            RegistrationOptions(body, context, db, handler, sessions, settings, true, ct)).WithSummary("Begin passkey recovery");
        passkeys.MapPost("/recovery", (RegistrationRequest body, HttpContext context, IPasskeyHandler<Operator> handler,
            ReviewService sessions, Settings settings, CancellationToken ct) =>
            Register(body, context, handler, sessions, settings, true, ct)).WithSummary("Replace the lost passkey and revoke administrator sessions");
        passkeys.MapPost("/authentication/options", AuthenticationOptions).WithSummary("Begin passkey verification");
        passkeys.MapPost("/authentication", Authenticate).WithSummary("Verify a passkey and unlock the administrator session");
    }

    private static async Task<Ok<AdminStatus>> Status(HttpContext context, Database db, ReviewService sessions, CancellationToken ct)
    {
        var initialized = await db.One<int>("SELECT EXISTS(SELECT 1 FROM Passkeys)", null, ct) == 1;
        var current = await sessions.Current(context, ct);
        return TypedResults.Ok(new AdminStatus(initialized, current is not null, current?.View));
    }

    private static async Task<Ok<ChallengeResponse>> RegistrationOptions(SetupRequest body, HttpContext context,
        Database db, IPasskeyHandler<Operator> handler, ReviewService sessions, Settings settings, bool recovery, CancellationToken ct)
    {
        RequireSetupSecret(body.Secret, settings);
        var user = await Admin(db, ct);
        if ((user.Revision != 0) != recovery)
            throw Fault.Conflict(recovery ? "passkey_not_configured" : "passkey_already_configured");
        var options = await handler.MakeCreationOptionsAsync(new PasskeyUserEntity
        {
            Id = user.Id,
            Name = user.Name,
            DisplayName = user.DisplayName
        }, context);
        var id = await sessions.Challenge(recovery ? "recovery" : "registration", user.Revision.ToString(CultureInfo.InvariantCulture),
            options.AttestationState ?? throw Fault.Unavailable("passkey_options_unavailable"), ct);
        return TypedResults.Ok(new ChallengeResponse(id, Wire.Parse(options.CreationOptionsJson)));
    }

    private static async Task<NoContent> Register(RegistrationRequest body, HttpContext context,
        IPasskeyHandler<Operator> handler, ReviewService sessions, Settings settings, bool recovery, CancellationToken ct)
    {
        RequireSetupSecret(body.Secret, settings);
        var challenge = await sessions.Consume(body.ChallengeId, recovery ? "recovery" : "registration", ct);
        var result = await handler.PerformAttestationAsync(new PasskeyAttestationContext
        {
            HttpContext = context,
            CredentialJson = Credential(body.Credential),
            AttestationState = challenge.State
        });
        if (!result.Succeeded || result.Passkey is null || result.UserEntity is null)
            throw Fault.Unauthorized();
        await sessions.ReplacePasskey(result.UserEntity.Id, long.Parse(challenge.Owner, CultureInfo.InvariantCulture), result.Passkey, ct);
        sessions.Clear(context);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<ChallengeResponse>> AuthenticationOptions(HttpContext context, Database db,
        IPasskeyHandler<Operator> handler, ReviewService sessions, CancellationToken ct)
    {
        var user = await Admin(db, ct);
        if (user.Revision == 0)
            throw Fault.Conflict("passkey_not_configured");
        var options = await handler.MakeRequestOptionsAsync(user, context);
        var id = await sessions.Challenge("assertion", user.Revision.ToString(CultureInfo.InvariantCulture),
            options.AssertionState ?? throw Fault.Unavailable("passkey_options_unavailable"), ct);
        return TypedResults.Ok(new ChallengeResponse(id, Wire.Parse(options.RequestOptionsJson)));
    }

    private static async Task<Ok<ReviewResponse>> Authenticate(CredentialRequest body, HttpContext context,
        IPasskeyHandler<Operator> handler, ReviewService sessions, CancellationToken ct)
    {
        var challenge = await sessions.Consume(body.ChallengeId, "assertion", ct);
        var result = await handler.PerformAssertionAsync(new PasskeyAssertionContext
        {
            HttpContext = context,
            CredentialJson = Credential(body.Credential),
            AssertionState = challenge.State
        });
        if (!result.Succeeded || result.User is not { } user || result.Passkey is null)
            throw Fault.Unauthorized();
        return TypedResults.Ok((await sessions.Start(context, user.Id, long.Parse(challenge.Owner, CultureInfo.InvariantCulture), result.Passkey, ct)).View);
    }

    private static async Task<Operator> Admin(Database db, CancellationToken ct) =>
        await db.One<Operator>("SELECT * FROM Operators WHERE Name='administrator'", null, ct)
        ?? throw new InvalidOperationException("Administrator account is missing.");

    private static string Credential(JsonElement value) => value.ValueKind == JsonValueKind.Object
        ? value.GetRawText() : throw Fault.Bad("invalid_credential");

    private static void RequireSetupSecret(string? input, Settings settings)
    {
        if (input is not { Length: >= 43 and <= 200 } ||
            !CryptographicOperations.FixedTimeEquals(settings.BootstrapHash, Secrets.HashBytes(input)))
            throw Fault.Unauthorized();
    }
}
