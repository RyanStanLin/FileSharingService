using System.Net;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileSharing;

internal static class SshRelayEndpoints
{
    internal sealed record Start(string? PublicKey);
    internal sealed record Jump(string? User, string? Fingerprint, string? Peer);

    public static void MapDevices(RouteGroupBuilder devices)
    {
        var routes = devices.MapGroup("/ssh-relays").WithTags("SSH relay");
        routes.MapPost("", Create).WithSummary("Authorize one SSH jump to the selected Mac");
        routes.MapDelete("/{relayId}", async (string id, string relayId, HttpContext ctx, ReviewService reviews,
            SshRelays relays, CancellationToken ct) =>
        {
            relays.Delete(id, relayId, await reviews.Require(ctx, ct));
            return TypedResults.NoContent();
        }).WithSummary("End this SSH relay");
    }

    private static async Task<Created<SshRelayView>> Create(string id, Start body, HttpContext ctx,
        ReviewService reviews, SshRelays relays, CancellationToken ct)
    {
        var relay = await relays.Create(id, await reviews.Require(ctx, ct), body.PublicKey, ct);
        return TypedResults.Created($"/api/v1/devices/{id}/ssh-relays/{relay.Id}", relay);
    }

    public static void MapWorker(RouteGroupBuilder worker)
    {
        worker.MapPost("/ssh/authorize", async (Jump body, SftpLoginLimit limit, SshRelays relays, CancellationToken ct) =>
        {
            if (!IPAddress.TryParse(body.Peer, out var peer) || !limit.Permit(peer))
                throw Fault.Unauthorized();
            return TypedResults.Ok(await relays.AuthorizeJump(body.User, body.Fingerprint, ct));
        });
        worker.MapGet("/ssh/stream/{relayId}", (string relayId, HttpContext ctx, SshRelays relays) => relays.Bridge(relayId, ctx));
    }

    public static void MapAgent(RouteGroupBuilder agent)
    {
        agent.MapGet("/ssh/{relayId}/input/{after:long}", async Task<IResult> (string relayId, long after,
            HttpContext ctx, SshRelays relays, CancellationToken ct) =>
        {
            var chunk = await relays.ForAgent(relayId, ctx).ReadInput(after, ct);
            return chunk is null ? TypedResults.NoContent() : TypedResults.Ok(chunk);
        });
        agent.MapPost("/ssh/{relayId}/output", async (string relayId, SshRelayChunk body, HttpContext ctx, SshRelays relays,
            CancellationToken ct) =>
        {
            await relays.ForAgent(relayId, ctx).WriteOutput(body, ct);
            return TypedResults.NoContent();
        });
    }
}
