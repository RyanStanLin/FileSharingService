using Microsoft.AspNetCore.Http.HttpResults;

namespace FileSharing;

internal static class RecordEndpoints
{
    public static void Map(RouteGroupBuilder devices)
    {
        var clipboard = devices.MapGroup("/clipboard/records").WithTags("Device records");
        clipboard.MapGet("", ListClipboard).WithSummary("List durable clipboard changes in newest-first order");
        clipboard.MapGet("/{recordId}", GetClipboard).WithSummary("Read a clipboard change and the text supplied by the agent");
        var dialogs = devices.MapGroup("/interactions/dialogs").WithTags("Device records");
        dialogs.MapGet("", ListDialogs).WithSummary("List the administrator's archived dialog replies");
        dialogs.MapGet("/{recordId}", GetDialog).WithSummary("Get an archived dialog reply and its field configuration");
    }

    private static async Task<Ok<Page<ClipboardRecord>>> ListClipboard(string id, string? cursor, int? limit, HttpContext ctx,
        Database db, DeviceService devices, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        id = await DeviceId(id, devices, ct);
        var take = Page<ClipboardRecord>.Size(limit);
        var upperBound = UpperBound(cursor);
        var rows = await db.List<ClipboardRecordRow>("""
            SELECT Sequence,DeviceId,Event,OccurredAt,RecordedAt,Content FROM ClipboardRecords
            WHERE DeviceId=@id AND Sequence<=@upperBound
            ORDER BY Sequence DESC LIMIT @size
            """, new { id, upperBound, size = take + 1 }, ct);
        return TypedResults.Ok(Page<ClipboardRecord>.From(rows.Select(row => row.View).ToArray(), take, row => row.Id));
    }

    private static async Task<Ok<ClipboardRecord>> GetClipboard(string id, string recordId, HttpContext ctx,
        Database db, DeviceService devices, ReviewService reviews, CancellationToken ct)
    {
        await reviews.Require(ctx, ct);
        id = await DeviceId(id, devices, ct);
        var sequence = EventFeed.Cursor(recordId);
        var record = await db.One<ClipboardRecordRow>("""
            SELECT Sequence,DeviceId,Event,OccurredAt,RecordedAt,Content FROM ClipboardRecords
            WHERE DeviceId=@id AND Sequence=@sequence
            """, new { id, sequence }, ct) ?? throw Fault.Missing("record_not_found");
        return TypedResults.Ok(record.View);
    }

    private static async Task<Ok<Page<DialogRecord>>> ListDialogs(string id, string? cursor, int? limit, HttpContext ctx,
        Database db, DeviceService devices, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        id = await DeviceId(id, devices, ct);
        var take = Page<DialogRecord>.Size(limit);
        var upperBound = UpperBound(cursor);
        var rows = await db.List<DialogRecordRow>("""
            SELECT Sequence,Id,DeviceId,Title,Outcome,ChoiceId,Created,Finished FROM DialogRecords
            WHERE DeviceId=@id AND Owner=@Initiator AND Sequence<=@upperBound
            ORDER BY Sequence DESC LIMIT @size
            """, new { id, review.Initiator, upperBound, size = take + 1 }, ct);
        return TypedResults.Ok(Page<DialogRecord>.From(rows.Select(row => row.View).ToArray(), take, row => row.Sequence));
    }

    private static async Task<Ok<DialogRecordDetail>> GetDialog(string id, string recordId, HttpContext ctx,
        Database db, DeviceService devices, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        id = await DeviceId(id, devices, ct);
        var record = await db.One<DialogRecordDetailRow>("""
            SELECT Sequence,Id,DeviceId,Title,Outcome,ChoiceId,Created,Finished,Request,Result FROM DialogRecords
            WHERE DeviceId=@id AND Owner=@Initiator AND Id=@recordId
            """, new { id, recordId = Secrets.Identifier(recordId), review.Initiator }, ct) ?? throw Fault.Missing("record_not_found");
        return TypedResults.Ok(record.Detail);
    }

    private static async Task<string> DeviceId(string id, DeviceService devices, CancellationToken ct)
    {
        id = Secrets.Identifier(id);
        if (await devices.Find(id, ct) is null)
            throw Fault.Missing("device_not_found");
        return id;
    }

    private static long UpperBound(string? cursor) => cursor is null ? long.MaxValue : EventFeed.Cursor(cursor) - 1;
}
