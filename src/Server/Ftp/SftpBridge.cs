using System.Net;
using System.Threading.RateLimiting;

namespace FileSharing;

internal sealed record SftpLogin(string Name, string Password, string Peer);
internal sealed record SftpOnline(string Fingerprint);
internal sealed record SftpLocation(string Path);
internal sealed record SftpList(string Path, int Offset, string? Revision, string? ConnectionId);
internal sealed record SftpRead(FtpPath Address, string Version, long Offset, int Length);

internal sealed class SftpLoginLimit : IDisposable
{
    private readonly PartitionedRateLimiter<IPAddress> attempts = PartitionedRateLimiter.Create<IPAddress, IPAddress>(
        peer => RateLimitPartition.GetFixedWindowLimiter(peer, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 18, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
        }));

    public bool Permit(IPAddress peer)
    {
        using var lease = attempts.AttemptAcquire(peer);
        return lease.IsAcquired;
    }

    public void Dispose() => attempts.Dispose();
}

internal static class SftpBridge
{
    public static void Map(WebApplication app)
    {
        // Middleware admits only the loopback worker with its process-local bearer secret.
        var bridge = app.MapGroup("/_sftp").ExcludeFromDescription();
        bridge.AddEndpointFilter((invocation, next) =>
            invocation.HttpContext.RequestServices.GetRequiredService<SftpRuntime>().Allows(invocation.HttpContext)
                ? next(invocation)
                : throw Fault.Missing());
        SshRelayEndpoints.MapWorker(bridge);
        bridge.MapPost("/online", (SftpOnline input, SftpRuntime state) =>
        {
            if (input.Fingerprint is not { Length: 50 } fp || !fp.StartsWith("SHA256:", StringComparison.Ordinal) ||
                !fp.AsSpan(7).ContainsOnlyBase64())
                throw Fault.Bad("invalid_ssh_fingerprint");
            state.Online(fp);
            return TypedResults.NoContent();
        });
        bridge.MapPost("/open", async (SftpLogin input, FtpAccounts accounts, GatewaySessions sessions, SftpLoginLimit limit, CancellationToken ct) =>
        {
            if (!IPAddress.TryParse(input.Peer, out var peer) || !limit.Permit(peer) ||
                input.Name is null || input.Password is null || await accounts.Login(input.Name, input.Password, "sftp", ct) is not { } identity)
                throw Fault.Unauthorized();
            var session = sessions.Start(identity, "sftp", peer);
            return TypedResults.Ok(new { token = session.Token });
        });
        bridge.MapPost("/active", async (HttpContext ctx, GatewaySessions sessions, CancellationToken ct) =>
        {
            await sessions.RequireSftp(Token(ctx), ct);
            return TypedResults.NoContent();
        });
        bridge.MapPost("/close", (HttpContext ctx, GatewaySessions sessions) =>
        {
            sessions.EndSftp(Token(ctx));
            return TypedResults.NoContent();
        });
        bridge.MapPost("/stat", async (SftpLocation input, HttpContext ctx, GatewaySessions sessions, FtpFiles fs, CancellationToken ct) =>
            TypedResults.Ok(await fs.Stat(await sessions.RequireSftp(Token(ctx), ct), Path(input.Path), ct)));
        bridge.MapPost("/list", async (SftpList input, HttpContext ctx, GatewaySessions sessions, FtpFiles fs, CancellationToken ct) =>
            TypedResults.Ok(await fs.Page(await sessions.RequireSftp(Token(ctx), ct), Path(input.Path), input.Offset,
                input.Revision, input.ConnectionId, ct)));
        bridge.MapPost("/file", async (SftpLocation input, HttpContext ctx, GatewaySessions sessions, FtpFiles fs, CancellationToken ct) =>
        {
            var (address, entry) = await fs.Prepare(await sessions.RequireSftp(Token(ctx), ct), Path(input.Path), 0, ct);
            if (entry.Size > FileService.MaximumBytes)
                throw new Fault(413, "too_large");
            return TypedResults.Ok(new { address, entry.Size, entry.Version });
        });
        bridge.MapPost("/read", async (SftpRead input, HttpContext ctx, GatewaySessions sessions, FtpFiles fs, CancellationToken ct) =>
        {
            if (input.Address is not { ConnectionId: not null } || input.Offset is < 0 or > FileService.MaximumBytes ||
                input.Length is < 1 or > FileService.Chunk || input.Version is not { Length: > 0 and <= 128 })
                throw Fault.Bad("invalid_read");
            var identity = await sessions.RequireSftp(Token(ctx), ct);
            return TypedResults.Bytes(await fs.Read(identity, input.Address, input.Version, input.Offset, input.Length, ct));
        });
    }

    private static string? Token(HttpContext context) => context.Request.Headers["X-FileSharing-SFTP-Session"] is { Count: 1 } values
        ? values[0]
        : null;

    private static string Path(string? value) => value is { Length: >= 1 and <= 3001 } && value[0] == '/'
        ? value
        : throw Fault.Bad("invalid_path");

    private static bool ContainsOnlyBase64(this ReadOnlySpan<char> span)
    {
        foreach (var c in span)
            if (!char.IsAsciiLetterOrDigit(c) && c is not ('+' or '/'))
                return false;
        return true;
    }
}
