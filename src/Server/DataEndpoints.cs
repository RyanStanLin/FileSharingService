using System.Text.Json;

namespace FileSharing;

internal sealed record SnapshotRow(string Topic, long At, string Payload)
{
    public SnapshotView View(bool online) => new(Topic, Clock.At(At), !online || Clock.Now - At > 900, Wire.Parse(Payload));
}
internal sealed record SnapshotView(string Topic, DateTimeOffset ObservedAt, bool Stale, JsonElement Value);
internal sealed record DeviceState(string DeviceId, AgentPresence Connection, IReadOnlyList<SnapshotView> Samples);
internal sealed record RefreshRequest(IReadOnlyList<string> Topics);
internal sealed record JobInput(string Kind);
internal sealed record JobRecord(string Id, string Owner, string DeviceId, string Kind, string State, long Created, long? Finished,
    string? Result, string? Error, string ReviewId)
{
    public JobView View => new(Id, DeviceId, Kind, State, Clock.At(Created), Finished is { } stop ? Clock.At(stop) : null,
        Result is null ? null : Wire.Parse(Result), Error);
}
internal sealed record JobView(string Id, string DeviceId, string Kind, string State, DateTimeOffset CreatedAt, DateTimeOffset? FinishedAt,
    JsonElement? Result, string? Error);

internal sealed class JobService(Database db, AgentBroker broker, ReviewService reviews, ILogger<JobService> logger)
{
    private readonly SemaphoreSlim slots = new(9);

    public async Task<JobView> Start(Review review, string device, string kind, object data, CancellationToken ct)
    {
        var connectionId = broker.RequireAccess(device);
        if (!slots.Wait(0))
            throw new Fault(429, "job_limit");
        var job = new JobRecord(Secrets.Id(), review.Initiator, device, kind, "queued", Clock.Now, null, null, null, review.Id);
        try
        {
            await db.Mutate("""
                INSERT INTO Jobs(Id,Owner,DeviceId,Kind,State,Created,ReviewId) VALUES(@Id,@Owner,@DeviceId,@Kind,@State,@Created,@ReviewId)
                """, job, job.Owner, job.DeviceId, "job.created", new { job.Id, job.Kind }, ct);
        }
        catch
        {
            slots.Release();
            throw;
        }
        _ = Run(job, data, connectionId);
        return job.View;
    }

    private async Task Run(JobRecord job, object data, string connectionId)
    {
        try
        {
            var commandTimeout = job.Kind == "permissions.request" ? TimeSpan.FromMinutes(3) : TimeSpan.FromSeconds(28);
            using var timeout = new CancellationTokenSource(commandTimeout + TimeSpan.FromSeconds(7));
            var ct = timeout.Token;
            if (await reviews.ActiveById(job.ReviewId, ct) is null)
            {
                await Finish(job, "cancelled", null, "review_ended");
                return;
            }
            var payload = await broker.Invoke(job.DeviceId, job.Kind, data, ct, timeout: commandTimeout, connectionId: connectionId);
            if (await reviews.ActiveById(job.ReviewId, ct) is null)
                await Finish(job, "cancelled", null, "review_ended");
            else
                await Finish(job, "completed", payload.GetRawText(), null);
        }
        catch (Exception error)
        {
            try
            {
                await Finish(job, "failed", null, (error as Fault)?.Code ?? "job_failed");
            }
            catch (Exception failure)
            {
                logger.LogError(failure, "Job persistence failed for {JobId}", job.Id);
            }
        }
        finally
        {
            slots.Release();
        }
    }

    private async Task Finish(JobRecord job, string state, string? result, string? error)
    {
        var stop = Clock.Now;
        var saved = await db.Execute("UPDATE Jobs SET State=@state,Result=@result,Error=@error,Finished=@stop WHERE Id=@Id AND State='queued'",
            new { state, result, error, stop, job.Id }, CancellationToken.None);
        if (saved == 1)
            await db.AppendEvent(job.DeviceId, "jobs.changed",
                Wire.Element(new { id = job.Id, state, kind = job.Kind }), CancellationToken.None);
    }
}

internal static class DataEndpoints
{
    private static readonly string[] StatusTopics = ["identity", "cpu", "memory", "disk", "battery", "power", "system", "displays", "locale", "network", "agent"];
    private static readonly string[] Permissions = ["downloads", "documents", "desktop", "inputMonitoring", "pasteboard"];
    private static readonly string[] Diagnostics = ["osVersion", "uptime", "diskSpace", "agentHealth"];

    public static void Map(RouteGroupBuilder api)
    {
        var devices = api.MapGroup("/devices/{id}").WithTags("Device data");
        devices.MapGet("/status", Status).WithSummary("Get the latest telemetry, timestamps and presence");
        devices.MapGet("/history", History).WithSummary("Page through historical measurements and events");
        devices.MapPost("/refresh", Refresh).WithSummary("Request a device snapshot refresh");
        devices.MapGet("/apps/running", async (string id, HttpContext ctx, Database db, DeviceService devices, ReviewService reviews, AgentBroker broker, CancellationToken ct) =>
            await Snapshot(id, "apps-running", ctx, db, devices, reviews, broker, ct)).WithSummary("Get running applications");
        devices.MapGet("/apps/installed", async (string id, HttpContext ctx, Database db, DeviceService devices, ReviewService reviews, AgentBroker broker, CancellationToken ct) =>
            await Snapshot(id, "apps-installed", ctx, db, devices, reviews, broker, ct)).WithSummary("Get installed applications");
        devices.MapGet("/apps/icon", Icon).WithSummary("Get a cached icon for an inventoried application");
        devices.MapGet("/storage", async (string id, HttpContext ctx, Database db, DeviceService devices, ReviewService reviews, AgentBroker broker, CancellationToken ct) =>
            await Snapshot(id, "storage", ctx, db, devices, reviews, broker, ct)).WithSummary("Get external storage and mount information");
        devices.MapGet("/permissions", async (string id, HttpContext ctx, Database db, DeviceService devices, ReviewService reviews, AgentBroker broker, CancellationToken ct) =>
            await Snapshot(id, "permissions", ctx, db, devices, reviews, broker, ct)).WithSummary("Get device permission states");
        devices.MapPost("/permissions/requests", RequestPermission).WithSummary("Ask macOS to evaluate or prompt for a supported permission");
        devices.MapPost("/diagnostics", RunDiagnostic).WithSummary("Run a predefined read-only diagnostic");
        api.MapGet("/jobs", ListJobs).WithTags("Jobs").WithSummary("List asynchronous jobs");
        api.MapGet("/jobs/{id}", GetJob).WithTags("Jobs").WithSummary("Get a job result");
        api.MapGet("/events", Events).WithTags("Events").WithSummary("Read a page of live-event history over REST");
        api.MapGet("/events/ws", BrowserEvents.Handle).WithTags("Events").WithSummary("Subscribe to events using WebSocket");
        FileEndpoints.Map(devices, api);
    }

    private static async Task<Ok<DeviceState>> Status(string id, HttpContext ctx, Database db, DeviceService devices, ReviewService reviews,
        AgentBroker broker, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var device = await devices.Require(id, ct);
        var connection = broker.Presence(id, device.LastSeen);
        var rows = await db.List<SnapshotRow>("SELECT Topic,At,Payload FROM Snapshots WHERE DeviceId=@id AND Topic IN @topics ORDER BY Topic",
            new { id, topics = StatusTopics }, ct);
        return TypedResults.Ok(new DeviceState(id, connection, rows.Select(x => x.View(connection.Online)).ToArray()));
    }

    private static async Task<Ok<EventsPage>> History(string id, string? topic, string? after, int? limit, DateTimeOffset? from, DateTimeOffset? to,
        HttpContext ctx, DeviceService devices, ReviewService reviews, EventFeed feed, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        return await Events(id, topic, after, limit, from, to, ctx, reviews, feed, ct);
    }

    private static async Task<Ok<SnapshotView>> Snapshot(string id, string topic, HttpContext ctx, Database db,
        DeviceService devices, ReviewService reviews, AgentBroker broker, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        var device = await devices.Require(id, ct);
        var row = await db.One<SnapshotRow>("SELECT Topic,At,Payload FROM Snapshots WHERE DeviceId=@id AND Topic=@topic",
            new { id, topic }, ct) ?? throw Fault.Missing("snapshot_unavailable");
        return TypedResults.Ok(row.View(broker.Presence(id, device.LastSeen).Online));
    }

    private static async Task<FileContentHttpResult> Icon(string id, string applicationId, HttpContext ctx, DeviceService devices,
        AgentBroker broker, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        var result = await broker.Invoke(id, "app.icon", new { applicationId = Secrets.Text(applicationId, 700) }, ct);
        var bytes = Convert.FromBase64String(Wire.Model<ReadChunk>(result).Data);
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
        var etag = new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{hash}\"");
        return TypedResults.File(bytes, "image/png", entityTag: etag);
    }

    private static async Task<Accepted<JobView>> Refresh(string id, RefreshRequest body, HttpContext ctx, DeviceService devices,
        ReviewService reviews, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        if (body.Topics is not { Count: > 0 and <= 17 } || body.Topics.Any(x => !AgentIngest.SnapshotTopics.Contains(x)))
            throw Fault.Bad("invalid_topics");
        var job = await jobs.Start(review, id, "status.refresh", new { topics = body.Topics.Distinct().ToArray() }, ct);
        return TypedResults.Accepted($"/api/v1/jobs/{job.Id}", job);
    }

    private static async Task<Accepted<JobView>> RequestPermission(string id, JobInput body, HttpContext ctx, DeviceService devices,
        ReviewService reviews, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        if (!Permissions.Contains(body.Kind))
            throw Fault.Bad("unsupported_permission");
        var job = await jobs.Start(review, id, "permissions.request", new { permission = body.Kind }, ct);
        return TypedResults.Accepted($"/api/v1/jobs/{job.Id}", job);
    }

    private static async Task<Accepted<JobView>> RunDiagnostic(string id, JobInput body, HttpContext ctx, DeviceService devices,
        ReviewService reviews, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        if (!Diagnostics.Contains(body.Kind))
            throw Fault.Bad("unsupported_diagnostic");
        var job = await jobs.Start(review, id, "diagnostics.run", new { diagnostic = body.Kind }, ct);
        return TypedResults.Accepted($"/api/v1/jobs/{job.Id}", job);
    }

    private static async Task<Ok<Page<JobView>>> ListJobs(string? deviceId, string? cursor, int? limit, HttpContext ctx,
        Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var take = Page<JobView>.Size(limit);
        var rows = await db.List<JobRecord>("""
            SELECT * FROM Jobs WHERE Owner=@Initiator AND Id>@after AND (@deviceId IS NULL OR DeviceId=@deviceId)
            ORDER BY Id LIMIT @size
            """, new { review.Initiator, after = Page<JobView>.After(cursor), deviceId, size = take + 1 }, ct);
        return TypedResults.Ok(Page<JobView>.From(rows.Select(x => x.View).ToArray(), take, x => x.Id));
    }

    private static async Task<Ok<JobView>> GetJob(string id, HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var row = await db.One<JobRecord>("SELECT * FROM Jobs WHERE Id=@id AND Owner=@Initiator",
            new { id = Secrets.Identifier(id), review.Initiator }, ct) ?? throw Fault.Missing();
        return TypedResults.Ok(row.View);
    }

    private static async Task<Ok<EventsPage>> Events(string? deviceId, string? topic, string? after, int? limit, DateTimeOffset? from, DateTimeOffset? to, HttpContext ctx,
        ReviewService reviews, EventFeed feed, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        if (topic is not null && (!EventFeed.Known(topic) || topic == "files.changed"))
            throw Fault.Bad("invalid_topic");
        if (from > to)
            throw Fault.Bad("invalid_time_range");
        if (deviceId is not null)
            Secrets.Identifier(deviceId);
        var cursor = EventFeed.Cursor(after);
        await feed.EnsureCursor(cursor, ct);
        return TypedResults.Ok(await feed.Read(cursor, deviceId, topic, Page<EventView>.Size(limit), false, ct,
            from?.ToUnixTimeSeconds(), to?.ToUnixTimeSeconds()));
    }
}
