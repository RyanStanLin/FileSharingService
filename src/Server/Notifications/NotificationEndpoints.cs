namespace FileSharing;

internal static class NotificationEndpoints
{
    private const string Prefix = "/api/v1/notifications";

    public static void Map(RouteGroupBuilder api)
    {
        var group = api.MapGroup("/notifications").WithTags("Notifications");
        group.AddEndpointFilter(async (context, next) =>
        {
            var request = context.HttpContext;
            var review = await request.RequestServices.GetRequiredService<ReviewService>().Require(request, request.RequestAborted);
            request.Items[typeof(Review)] = review;
            return await next(context);
        });

        group.MapGet("/channels", ListChannels).WithSummary("List saved notification channels with redacted credentials");
        group.MapGet("/channels/{id}", GetChannel).WithSummary("Get a saved notification channel");
        group.MapPost("/channels", CreateChannel).WithSummary("Create a Bark or Telegram notification channel");
        group.MapPut("/channels/{id}", UpdateChannel).WithSummary("Replace channel settings and optionally rotate its credential");
        group.MapDelete("/channels/{id}", DeleteChannel).WithSummary("Delete a notification channel by revision");
        group.MapPost("/channels/{id}/verify", VerifyTelegram).WithSummary("Verify a Telegram bot and look up its destination chat")
            .ProducesProblem(502);
        group.MapPost("/channels/{id}/test", TestChannel).WithSummary("Queue a test notification through a channel");
        group.MapGet("/deliveries", ListDeliveries).WithSummary("Read filtered notification delivery history");
        group.MapGet("/deliveries/{id}", GetDelivery).WithSummary("Get the latest state of a notification delivery");
        group.MapGet("/updates", ReadUpdates).WithSummary("Replay change summaries from the notification WebSocket topic");
        group.MapGet("/event-types", EventTypes).WithSummary("Describe notification events, variables, filters and limits");
        group.MapGet("/rules", ListRules).WithSummary("List notification rules and matching counters");
        group.MapGet("/rules/{id}", GetRule).WithSummary("Get a notification rule");
        group.MapPost("/rules", CreateRule).WithSummary("Create a multi-event notification rule");
        group.MapPut("/rules/{id}", UpdateRule).WithSummary("Replace a notification rule by revision");
        group.MapDelete("/rules/{id}", DeleteRule).WithSummary("Delete a notification rule by revision");
        group.MapPost("/rules/preview", PreviewRule).WithSummary("Render a notification template with sample values");
        group.MapGet("/watches", ListWatches).WithSummary("List runtime status of directory watches for enabled rules");
    }

    internal static string Actor(HttpContext context) => ((Review)context.Items[typeof(Review)]!).Initiator;

    private static async Task<Ok<Page<NotificationChannelView>>> ListChannels(string? cursor, int? limit, INotificationChannels channels, CancellationToken ct) =>
        TypedResults.Ok(await channels.List(cursor, limit, ct));

    private static async Task<Ok<NotificationChannelView>> GetChannel(string id, INotificationChannels channels, CancellationToken ct) =>
        TypedResults.Ok(await channels.Get(id, ct));

    private static async Task<Created<NotificationChannelView>> CreateChannel(NotificationChannelRequest body, HttpContext context,
        INotificationChannels channels, CancellationToken ct)
    {
        var channel = await channels.Save(null, body, Actor(context), ct);
        return TypedResults.Created($"{Prefix}/channels/{channel.Id}", channel);
    }

    private static async Task<Ok<NotificationChannelView>> UpdateChannel(string id, NotificationChannelRequest body, HttpContext context,
        INotificationChannels channels, CancellationToken ct) =>
        TypedResults.Ok(await channels.Save(id, body, Actor(context), ct));

    private static async Task<NoContent> DeleteChannel(string id, long? revision, HttpContext context, INotificationChannels channels,
        CancellationToken ct)
    {
        await channels.Delete(id, revision, Actor(context), ct);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<TelegramVerification>> VerifyTelegram(string id, INotificationChannels channels, CancellationToken ct) =>
        TypedResults.Ok(await channels.Verify(id, ct));

    private static async Task<Accepted<NotificationDeliveryView>> TestChannel(string id, NotificationTestRequest body, HttpContext context,
        INotificationDeliveries deliveries, CancellationToken ct)
    {
        var key = context.Request.Headers["Idempotency-Key"];
        if (key.Count > 1)
            throw Fault.Bad("invalid_idempotency_key");
        var item = await deliveries.Test(id, key.Count == 1 ? key[0] : null, body, Actor(context), ct);
        return TypedResults.Accepted($"{Prefix}/deliveries/{item.Id}", item);
    }

    private static async Task<Ok<NotificationDeliveriesPage>> ListDeliveries(string? after, int? limit, string? channelId, string? ruleId,
        string? deviceId, string? state, INotificationDeliveries deliveries, CancellationToken ct) =>
        TypedResults.Ok(await deliveries.List(after, limit, channelId, ruleId, deviceId, state, ct));

    private static async Task<Ok<NotificationDeliveryView>> GetDelivery(string id, INotificationDeliveries deliveries, CancellationToken ct) =>
        TypedResults.Ok(await deliveries.Get(id, ct));

    private static Ok<NotificationCatalogView> EventTypes(NotificationVault vault, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return TypedResults.Ok(new NotificationCatalogView(NotificationCatalog.Types, vault.Enabled,
            NotificationRules.Maximum, NotificationChannels.Maximum, NotificationRules.MaximumChannels, NotificationFileWatches.MaximumPerDevice));
    }

    private static async Task<Ok<Page<NotificationRuleView>>> ListRules(string? cursor, int? limit, string? deviceId, bool? enabled,
        INotificationRules rules, CancellationToken ct) =>
        TypedResults.Ok(await rules.List(cursor, limit, deviceId, enabled, ct));

    private static async Task<Ok<NotificationRuleView>> GetRule(string id, INotificationRules rules, CancellationToken ct) =>
        TypedResults.Ok(await rules.Get(id, ct));

    private static async Task<Created<NotificationRuleView>> CreateRule(NotificationRuleRequest body, HttpContext context,
        INotificationRules rules, CancellationToken ct)
    {
        var rule = await rules.Save(null, body, Actor(context), ct);
        return TypedResults.Created($"{Prefix}/rules/{rule.Id}", rule);
    }

    private static async Task<Ok<NotificationRuleView>> UpdateRule(string id, NotificationRuleRequest body, HttpContext context,
        INotificationRules rules, CancellationToken ct) =>
        TypedResults.Ok(await rules.Save(id, body, Actor(context), ct));

    private static async Task<NoContent> DeleteRule(string id, long? revision, HttpContext context, INotificationRules rules,
        CancellationToken ct)
    {
        await rules.Delete(id, revision, Actor(context), ct);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<NotificationFileWatchView[]>> ListWatches(string? deviceId, NotificationFileWatches watches, CancellationToken ct) =>
        TypedResults.Ok(await watches.List(deviceId, ct));

    private static Ok<NotificationPreview> PreviewRule(NotificationPreviewRequest body, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return TypedResults.Ok(NotificationTemplates.Preview(body));
    }

    private static async Task<Ok<EventsPage>> ReadUpdates(string? after, int? limit, NotificationUpdates updates, CancellationToken ct)
    {
        var cursor = EventFeed.Cursor(after);
        await updates.EnsureCursor(cursor, ct);
        return TypedResults.Ok(await updates.Read(cursor, Page<EventView>.Size(limit), ct));
    }
}
