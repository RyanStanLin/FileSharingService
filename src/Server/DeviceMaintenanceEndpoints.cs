namespace FileSharing;

internal static class DeviceMaintenanceEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var group = api.MapGroup("/devices/{id}/maintenance").WithTags("Device maintenance");
        group.MapGet("", Status).WithSummary("Read the device's maintenance window and connected Agent capability");
        group.MapPost("", Start).WithSummary("Arm a fixed ten-minute restart pause on an authorized Agent connection");
        group.MapDelete("/{leaseId}", End).WithSummary("Release a maintenance window even while the Agent is stopped");
    }

    private static async Task<Ok<DeviceMaintenanceView>> Status(string id, HttpContext context, ReviewService reviews,
        IDeviceMaintenance maintenance, CancellationToken ct)
    {
        await reviews.Require(context, ct);
        return TypedResults.Ok(await maintenance.Status(id, ct));
    }

    private static async Task<Created<DeviceMaintenanceView>> Start(string id, StartMaintenanceRequest body, HttpContext context,
        ReviewService reviews, IDeviceMaintenance maintenance, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        var lease = await maintenance.Start(id, body.ConnectionId, review.Initiator, ct);
        return TypedResults.Created($"/api/v1/devices/{id}/maintenance", lease);
    }

    private static async Task<NoContent> End(string id, string leaseId, HttpContext context, ReviewService reviews,
        IDeviceMaintenance maintenance, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        await maintenance.End(id, leaseId, review.Initiator, ct);
        return TypedResults.NoContent();
    }
}
