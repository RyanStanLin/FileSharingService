namespace FileSharing;

internal static class FileEndpoints
{
    public static void Map(RouteGroupBuilder devices, RouteGroupBuilder api)
    {
        var files = devices.MapGroup("/files").WithTags("Files");
        files.MapGet("/entries", Browse).WithSummary("List the requested directory at a consistent revision");
        files.MapGet("/entry", Stat).WithSummary("Return metadata for one entry");
        files.MapPost("/directories", Directory).WithSummary("Create a directory within a writable root");
        files.MapPost("/moves", Move).WithSummary("Rename or move an entry within its root");
        files.MapPost("/renames", Rename).WithSummary("Change an entry name or extension");
        files.MapPost("/trash", Trash).WithSummary("Move an entry to the managed user's Trash");
        files.MapDelete("/entry", Purge).WithSummary("Delete an entry permanently");
        files.MapGet("/thumbnail", Thumbnail).Produces(200, contentType: "image/png").WithSummary("Read a bounded PNG thumbnail");

        var transfers = api.MapGroup("/transfers").WithTags("Transfers");
        transfers.MapPost("/", CreateTransfer).WithSummary("Start an upload, download, or ZIP64 archive");
        transfers.MapGet("/", ListTransfers).WithSummary("List transfers for the current initiator");
        transfers.MapGet("/{id}", GetTransfer).WithSummary("Read transfer state and progress");
        transfers.MapDelete("/{id}", CancelTransfer).WithSummary("Cancel a transfer");
        transfers.MapMethods("/{id}/content", ["GET", "HEAD"], Content).Produces(200, contentType: "application/octet-stream")
            .Produces(206, contentType: "application/octet-stream").WithSummary("Stream content with HTTP byte range support");
        transfers.MapPut("/{id}/content", Upload).Accepts<byte[]>("application/octet-stream").WithSummary("Write an upload chunk at its offset");
        transfers.MapPost("/{id}/commit", Commit).WithSummary("Publish a completed upload atomically");
    }

    private static async Task<Ok<DirectoryPage>> Browse(string id, string rootId, string? path, bool? hidden, int? offset,
        int? limit, string? revision, string? sort, string? direction, HttpContext ctx, FileService files, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        if (direction is not (null or "asc" or "desc"))
            throw Fault.Bad("invalid_sort_direction");
        return TypedResults.Ok(await files.List(review, id, rootId, path ?? "", hidden == true, offset ?? 0,
            Page<FileEntry>.Size(limit), revision, ct, sort ?? "name", direction == "desc"));
    }

    private static async Task<Ok<FileEntry>> Stat(string id, string rootId, string? path, bool? summary, HttpContext ctx, FileService files,
        ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        return TypedResults.Ok(await files.Stat(review, id, rootId, path ?? "", ct, summary != false));
    }

    private static async Task<Created<FileEntry>> Directory(string id, FileLocation body, HttpContext ctx, FileService files,
        ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var result = Wire.Model<FileEntry>(await files.Mutate(review, id, new(body.RootId, body.Path, null, null), "mkdir", ct));
        return TypedResults.Created($"/api/v1/devices/{id}/files/entry?rootId={body.RootId}&path={Uri.EscapeDataString(body.Path)}", result);
    }

    private static async Task<Ok<FileEntry>> Move(string id, FileMutation body, HttpContext ctx, FileService files,
        ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        return TypedResults.Ok(Wire.Model<FileEntry>(await files.Mutate(review, id, body, "move", ct)));
    }

    private static async Task<Ok<FileEntry>> Rename(string id, RenameInput body, HttpContext ctx, FileService files,
        ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var path = FileService.EntryPath(body.Path);
        var name = FileService.EntryPath(body.NewName);
        if (name.Contains('/'))
            throw Fault.Bad("invalid_file_name");
        var index = path.LastIndexOf('/');
        var destination = index < 0 ? name : path[..(index + 1)] + name;
        return TypedResults.Ok(Wire.Model<FileEntry>(await files.Mutate(
            review, id, new(body.RootId, path, destination, body.Version), "move", ct)));
    }

    private static async Task<Ok<TrashResult>> Trash(string id, TrashInput body, HttpContext ctx,
        FileService files, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        return TypedResults.Ok(Wire.Model<TrashResult>(await files.Mutate(
            review, id, new(body.RootId, body.Path, null, body.Version), "trash", ct)));
    }

    private static async Task<NoContent> Purge(string id, string rootId, string path, string version, bool? recursive,
        HttpContext ctx, FileService files, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        await files.Mutate(review, id, new(rootId, path, null, version), "purge", ct, recursive == true);
        return TypedResults.NoContent();
    }

    private static async Task<FileContentHttpResult> Thumbnail(string id, string rootId, string path, string version,
        HttpContext ctx, FileService files, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var png = await files.Thumbnail(review, id, rootId, path, version, ct);
        return TypedResults.File(png, "image/png");
    }

    private static async Task<Results<Created<TransferView>, Ok<TransferView>>> CreateTransfer(TransferInput body, HttpContext ctx,
        TransferService service, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var (transfer, isNew) = await service.Start(review, body, ctx.Request.Headers["Idempotency-Key"].ToString(), ct);
        return isNew ? TypedResults.Created($"/api/v1/transfers/{transfer.Id}", transfer.View) : TypedResults.Ok(transfer.View);
    }

    private static async Task<Ok<Page<TransferView>>> ListTransfers(string? cursor, string? deviceId, string? state, int? limit,
        HttpContext ctx, Database db, ReviewService reviews, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        var take = Page<TransferView>.Size(limit);
        var rows = await db.List<TransferRecord>("""
            SELECT * FROM Transfers WHERE Owner=@Initiator AND Id>@after AND (@deviceId IS NULL OR DeviceId=@deviceId)
                AND (@state IS NULL OR State=@state) ORDER BY Id LIMIT @size
            """, new { review.Initiator, after = Page<TransferView>.After(cursor), deviceId, state, size = take + 1 }, ct);
        return TypedResults.Ok(Page<TransferView>.From(rows.Select(t => t.View).ToArray(), take, t => t.Id));
    }

    private static async Task<Ok<TransferView>> GetTransfer(string id, HttpContext ctx, TransferService service,
        ReviewService reviews, CancellationToken ct) => TypedResults.Ok((await service.Get(await reviews.Require(ctx, ct), id, ct)).View);

    private static async Task<NoContent> CancelTransfer(string id, HttpContext ctx, TransferService service,
        ReviewService reviews, CancellationToken ct)
    {
        await service.Cancel(await reviews.Require(ctx, ct), id, ct);
        return TypedResults.NoContent();
    }

    private static async Task Content(string id, HttpContext ctx, TransferService service, ReviewService reviews, CancellationToken ct) =>
        await service.Serve(ctx, await reviews.Require(ctx, ct), id, ct);

    private static async Task<NoContent> Upload(string id, HttpContext ctx, TransferService service, ReviewService reviews,
        [Microsoft.AspNetCore.Mvc.FromHeader(Name = "Upload-Offset")] long offset, CancellationToken ct)
    {
        var review = await reviews.Require(ctx, ct);
        if (ctx.Request.ContentLength is not (> 0 and <= FileService.Chunk))
            throw new Fault(413, "invalid_chunk_length");
        var bytes = new byte[(int)ctx.Request.ContentLength.Value];
        await ctx.Request.Body.ReadExactlyAsync(bytes, ct);
        ctx.Response.Headers["Upload-Offset"] = (await service.Upload(review, id, offset, bytes, ct)).ToString();
        return TypedResults.NoContent();
    }

    private static async Task<Ok<FileEntry>> Commit(string id, HttpContext ctx, TransferService service, ReviewService reviews,
        CancellationToken ct) => TypedResults.Ok(await service.Commit(await reviews.Require(ctx, ct), id, ct));
}
