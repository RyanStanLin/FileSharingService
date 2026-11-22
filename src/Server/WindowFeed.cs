using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileSharing;

/// <summary>A rectangle in macOS logical screen points, with y increasing downwards.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowBounds(double X, double Y, double Width, double Height);

/// <summary>The global bounds of an active display.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowDisplay(uint Id, bool Main, WindowBounds Bounds);

/// <summary>Estimated rectangular coverage by higher, fully opaque windows.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowOcclusion(string State, double? CoveredFraction, IReadOnlyList<uint> OccludingWindowIds);

/// <summary>Geometry, stacking and focus metadata for one WindowServer window.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowDetails(uint Id, int Pid, string? OwnerName, int Layer, double Alpha, WindowBounds Bounds,
    uint? DisplayId, WindowBounds? RelativeBounds, bool OnScreen, int? ZIndex, bool Frontmost, bool OwnerFrontmost,
    bool Focused, WindowOcclusion Occlusion);

/// <summary>A complete observation of the current macOS graphical session.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowState(bool Available, IReadOnlyList<WindowDisplay> Displays, int? ActivePid, string FocusStatus,
    uint? FocusedWindowId, IReadOnlyList<WindowDetails> Windows, bool Truncated);

/// <summary>The latest window state and its opaque revision for WS or REST polling.</summary>
internal sealed record WindowSnapshot(string Revision, DateTimeOffset ObservedAt, WindowState Value);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record WindowReport(string WatchId, WindowState Value);
internal sealed record WindowLease(AgentBroker.Link Link, string WatchId);

// All members are guarded by the owning agent link's lock.
internal sealed class WindowChannel
{
    internal const int LeaseSeconds = 20;
    public string? WatchId { get; set; }
    public long RequestedAt { get; set; }
    public Task<JsonElement>? Renewal { get; set; }
    public WindowSnapshot? Latest { get; private set; }
    public TaskCompletionSource Changed { get; private set; } = CreateSignal();
    public bool Expired => WatchId is not null && Stopwatch.GetElapsedTime(RequestedAt).TotalSeconds >= LeaseSeconds;

    public void Update(WindowSnapshot? snapshot)
    {
        Latest = snapshot;
        var previous = Changed;
        Changed = CreateSignal();
        previous.TrySetResult();
    }

    public void Clear()
    {
        WatchId = null;
        RequestedAt = 0;
        Renewal = null;
        Update(null);
    }

    private static TaskCompletionSource CreateSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class WindowFeed(AgentBroker broker)
{
    public const string Topic = "windows.changed";
    public const int MaximumWaitSeconds = 10;

    public static string? Revision(string? value) => value is null ? null
        : Guid.TryParseExact(value, "D", out var revision) ? revision.ToString("D") : throw Fault.Bad("invalid_cursor");

    public async Task<WindowLease> Open(string device, CancellationToken ct)
    {
        var link = broker.AccessibleLink(device);
        WindowLease lease;
        lock (link)
        {
            if (!broker.HasAccess(link))
                throw Fault.Forbidden("agent_connection_access_required");
            if (link.Windows.Expired)
                link.Windows.Clear();
            lease = new(link, link.Windows.WatchId ??= Secrets.Id());
            if (link.Windows.RequestedAt == 0)
                link.Windows.RequestedAt = Stopwatch.GetTimestamp();
        }
        await Renew(lease, ct);
        return lease;
    }

    public async Task Renew(WindowLease lease, CancellationToken ct)
    {
        Task renewal;
        var link = lease.Link;
        lock (link)
        {
            var channel = Require(lease);
            if (channel.Renewal is null || channel.Renewal.IsCompleted &&
                Stopwatch.GetElapsedTime(channel.RequestedAt).TotalSeconds >= (channel.Renewal.IsCompletedSuccessfully ? 5 : 1))
            {
                channel.RequestedAt = Stopwatch.GetTimestamp();
                channel.Renewal = broker.Invoke(link.Device, "windows.observe", new { lease.WatchId, seconds = WindowChannel.LeaseSeconds },
                    link.Lifetime, timeout: TimeSpan.FromSeconds(4), connectionId: link.Id);
            }
            renewal = channel.Renewal;
        }
        await renewal.WaitAsync(ct);
    }

    public async Task<WindowSnapshot?> Read(WindowLease lease, string? after, int waitSeconds, CancellationToken ct)
    {
        Task changed;
        lock (lease.Link)
        {
            var channel = Require(lease);
            if (channel.Latest is { } current && current.Revision != after)
                return current;
            if (waitSeconds == 0)
                return null;
            changed = channel.Changed.Task;
        }
        try
        {
            await changed.WaitAsync(TimeSpan.FromSeconds(waitSeconds), ct);
        }
        catch (TimeoutException)
        {
        }
        lock (lease.Link)
        {
            var current = Require(lease).Latest;
            if (current is null)
                throw Fault.Unavailable("window_snapshot_unavailable");
            return current.Revision != after ? current : null;
        }
    }

    public Task NextChange(WindowLease lease, string? after)
    {
        var link = lease.Link;
        lock (link)
        {
            var channel = link.Windows;
            if (!broker.HasAccess(link) || channel.WatchId != lease.WatchId || channel.Expired ||
                channel.Latest is { } snapshot && snapshot.Revision != after)
                return Task.CompletedTask;
            return channel.Changed.Task;
        }
    }

    public void Ingest(AgentBroker.Link link, string revision, bool? isSnapshot, JsonElement payload)
    {
        lock (link)
        {
            var channel = link.Windows;
            if (!broker.HasAccess(link) || channel.WatchId is null || channel.Expired || channel.Latest?.Revision == revision)
                return;
            if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty("watchId", out var id) ||
                id.ValueKind != JsonValueKind.String || id.GetString() != channel.WatchId)
                return;
        }
        if (isSnapshot != true || payload.GetRawText().Length > 1_150_000)
            throw Fault.Bad("invalid_window_snapshot");
        WindowReport report;
        try
        {
            report = Wire.Model<WindowReport>(payload);
        }
        catch (JsonException)
        {
            throw Fault.Bad("invalid_window_snapshot");
        }
        if (report.Value is not { Windows.Count: <= 1024, Displays.Count: <= 32 } value ||
            value.FocusStatus is not ("foreground" or "noFocusedWindow" or "unavailable") ||
            value.Windows.Any(w => w is null || w.Bounds is null || w.Occlusion?.OccludingWindowIds is not { Count: <= 16 }) ||
            value.Displays.Any(d => d is null || d.Bounds is null))
            throw Fault.Bad("invalid_window_snapshot");
        lock (link)
        {
            if (broker.HasAccess(link) && link.Windows.WatchId == report.WatchId && !link.Windows.Expired)
                link.Windows.Update(new WindowSnapshot(revision, DateTimeOffset.UtcNow, value));
        }
    }

    private WindowChannel Require(WindowLease lease)
    {
        if (lease.Link.Lifetime.IsCancellationRequested)
            throw Fault.Unavailable("agent_connection_ended");
        if (!broker.HasAccess(lease.Link))
            throw Fault.Forbidden("agent_connection_access_required");
        var channel = lease.Link.Windows;
        if (channel.WatchId != lease.WatchId || channel.Expired)
            throw Fault.Conflict("window_stream_ended");
        return channel;
    }
}

internal static class WindowEndpoints
{
    public static void Map(RouteGroupBuilder devices)
    {
        devices.MapGet("/windows", Read)
            .WithSummary("Get window geometry, stacking, occlusion and focus")
            .WithDescription("Returns the latest window snapshot for an authorized device connection. Pass its revision as after to poll for changes.")
            .ProducesProblem(400).ProducesProblem(403).ProducesProblem(503);
    }

    private static async Task<Results<Ok<WindowSnapshot>, NoContent>> Read(string id, string? after, int? waitSeconds,
        HttpContext ctx, ReviewService reviews, DeviceService devices, WindowFeed windows, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await devices.Require(id, ct);
        after = WindowFeed.Revision(after);
        if (waitSeconds is < 0 or > WindowFeed.MaximumWaitSeconds)
            throw Fault.Bad("invalid_window_wait");
        var lease = await windows.Open(id, ct);
        var snapshot = await windows.Read(lease, after, 0, ct);
        if (snapshot is null)
            snapshot = await windows.Read(lease, after, waitSeconds ?? (after is null ? 4 : 0), ct);
        if (await reviews.ActiveById(review.Id, ct) is null)
            throw Fault.Unauthorized();
        return snapshot is not null ? TypedResults.Ok(snapshot)
            : after is null ? throw Fault.Unavailable("window_snapshot_unavailable") : TypedResults.NoContent();
    }
}
