using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using Dapper;

namespace FileSharing;

internal sealed record FileEntry(string Name, string Path, string FullPath, string Kind, long Size, DateTimeOffset? CreatedAt,
    DateTimeOffset ModifiedAt, long Owner, int Mode, string Version, bool Hidden, string? Extension = null,
    DateTimeOffset? LastOpenedAt = null, DateTimeOffset? LastAccessedAt = null, string? FileType = null,
    string? Thumbnail = null, FolderSummary? Folder = null);
internal sealed record FolderSummary(long FolderSize, long FilesCount, long FoldersCount, bool Complete);
internal sealed record DirectoryPage(string Revision, IReadOnlyList<FileEntry> Items, int? NextOffset, int Total, string SnapshotRevision);
internal sealed record FileLocation(string RootId, string Path);
internal sealed record FileMutation(string RootId, string Path, string? Destination, string? Version, string? DestinationRootId = null);
internal sealed record RenameInput(string RootId, string Path, string NewName, string Version);
internal sealed record TrashInput(string RootId, string Path, string Version);
internal sealed record TrashResult(string Path, string TrashName);
internal sealed record ReadChunk(string Data);
internal sealed record WriteOffset(long Offset);

internal sealed class FileService(DeviceService devices, AgentBroker broker, ReviewService reviews, Database db)
{
    public const int Chunk = 262_144;
    public const long MaximumBytes = 64L * 1024 * 1024 * 1024;

    public static string PathKey(string? input)
    {
        if (input is null || input.Length == 0)
            return "";
        if (input.Length > 3000 || input.Any(char.IsControl) || input.Contains('\\'))
            throw Fault.Bad("invalid_path");
        var parts = input.Split('/');
        if (parts.Length > 40 || parts.Any(x => x is "" or "." or ".." || x.StartsWith(".filesharing-", StringComparison.OrdinalIgnoreCase)
            || Encoding.UTF8.GetByteCount(x) > 255))
            throw Fault.Bad("invalid_path");
        return input;
    }

    public static string EntryPath(string? path) =>
        PathKey(path) is { Length: > 0 } value ? value : throw Fault.Bad("entry_path_required");

    public async Task<DirectoryPage> List(Review review, string device, string rootId, string path, bool hidden,
        int offset, int limit, string? revision, CancellationToken ct, string sort = "name", bool descending = false,
        string? connectionId = null)
    {
        if (offset < 0 || offset > 50_000 || offset > 0 && revision is null || limit is < 1 or > 200)
            throw Fault.Bad("invalid_directory_page");
        if (sort is not ("name" or "size" or "createdAt" or "modifiedAt" or "type" or "lastOpenedAt"))
            throw Fault.Bad("invalid_sort");
        var root = await Allow(review, device, rootId, false, ct, connectionId);
        return await ListGranted(root, path, hidden, offset, limit, revision, ct, sort, descending);
    }

    public async Task<FileEntry> Stat(Review review, string device, string rootId, string path, CancellationToken ct, bool summary = false,
        string? connectionId = null)
    {
        var root = await Allow(review, device, rootId, false, ct, connectionId);
        return await StatGranted(root, path, ct, summary);
    }

    internal async Task<DirectoryPage> ListGranted(RootInfo root, string path, bool hidden, int offset, int limit,
        string? revision, CancellationToken ct, string sort = "name", bool descending = false)
    {
        var result = await broker.Invoke(root.DeviceId, "files.list",
            new { root = root.RootKey, path = PathKey(path), hidden, offset, limit, revision, sort, descending }, ct, connectionId: root.ConnectionId);
        return Wire.Model<DirectoryPage>(result);
    }

    internal async Task<FileEntry> StatGranted(RootInfo root, string path, CancellationToken ct, bool summary = false) =>
        Wire.Model<FileEntry>(await broker.Invoke(root.DeviceId, "files.stat", new { root = root.RootKey, path = PathKey(path), summary }, ct, connectionId: root.ConnectionId));

    public async Task<byte[]> Thumbnail(Review review, string device, string rootId, string path, string version, CancellationToken ct)
    {
        RequireVersionIfNeeded(version, "thumbnail");
        var root = await Allow(review, device, rootId, false, ct);
        var payload = await broker.Invoke(device, "files.thumbnail", new { root = root.RootKey, path = PathKey(path), version }, ct, connectionId: root.ConnectionId);
        var data = Convert.FromBase64String(Wire.Model<ReadChunk>(payload).Data);
        if (data.Length > Chunk)
            throw Fault.Unavailable("thumbnail_unavailable");
        return data;
    }

    public async Task<JsonElement> Mutate(Review review, string device, FileMutation input, string kind,
        CancellationToken ct, bool recursive = false)
    {
        var root = await Allow(review, device, input.RootId, true, ct);
        var path = EntryPath(input.Path);
        var destination = kind == "move" ? EntryPath(input.Destination) : null;
        var destinationGrant = destination is not null && input.DestinationRootId is { } target && target != root.Id
            ? await Allow(review, device, target, true, ct, root.ConnectionId) : root;
        if (root.Id == destinationGrant.Id && (destination == path || destination?.StartsWith(path + "/", StringComparison.Ordinal) == true))
            throw Fault.Bad("invalid_destination");
        RequireVersionIfNeeded(input.Version, kind);
        var auditId = Secrets.Id();
        var audit = new { auditId, input.RootId, path, destination, destinationRootId = destinationGrant.Id, recursive };
        await db.Audit($"files.{kind}.requested", review.Initiator, device, audit, ct);
        var value = await broker.Invoke(device, $"files.{kind}", new { root = root.RootKey, path, destination,
            destinationRoot = destinationGrant.RootKey, input.Version, recursive, recoveryId = auditId }, ct, auditId, connectionId: root.ConnectionId);
        await db.Audit($"files.{kind}.completed", review.Initiator, device, audit, CancellationToken.None);
        return value;
    }

    public async Task<RootInfo> Allow(Review review, string id, string root, bool write, CancellationToken ct, string? connectionId = null)
    {
        if (await reviews.ActiveById(review.Id, ct) is not { } current)
            throw Fault.Unauthorized();
        await reviews.Touch(current.Id, current.LastAccess, ct);
        return await devices.Scope(id, root, write, ct, connectionId);
    }

    public Task Pump(Review review, string device, string rootId, string path, string version, long start, long size,
        Stream output, Func<long, CancellationToken, Task>? progress, CancellationToken ct, string? connectionId = null) =>
        Pump(path, version, start, size, output, token => Allow(review, device, rootId, false, token, connectionId), progress, ct);

    internal async Task Pump(string path, string version, long start, long size, Stream output,
        Func<CancellationToken, Task<RootInfo>> authorize, Func<long, CancellationToken, Task>? progress, CancellationToken ct)
    {
        var offset = start;
        var end = checked(start + size);
        string? connectionId = null;
        while (offset < end)
        {
            var root = await authorize(ct);
            connectionId ??= root.ConnectionId;
            var count = (int)Math.Min(Chunk, end - offset);
            var result = await broker.Invoke(root.DeviceId, "files.read", new { root = root.RootKey, path, version, offset, count }, ct, connectionId: connectionId);
            var data = Convert.FromBase64String(Wire.Model<ReadChunk>(result).Data);
            if (data.Length != count)
                throw Fault.Conflict("source_changed");
            await output.WriteAsync(data, ct);
            offset += count;
            if (progress is not null)
                await progress(offset, ct);
        }
    }

    public async Task Write(Review review, TransferRecord transfer, ReadOnlyMemory<byte> bytes, long offset, CancellationToken ct)
    {
        var root = await Allow(review, transfer.DeviceId, transfer.RootId, true, ct);
        var result = await broker.Invoke(transfer.DeviceId, "files.write", new
        {
            root = root.RootKey, transfer.Path, transferId = transfer.Id, offset, data = Convert.ToBase64String(bytes.Span)
        }, ct, connectionId: root.ConnectionId);
        if (Wire.Model<WriteOffset>(result).Offset < offset + bytes.Length)
            throw Fault.Conflict("invalid_offset");
    }

    public async Task<FileEntry> Commit(Review review, TransferRecord transfer, CancellationToken ct)
    {
        var root = await Allow(review, transfer.DeviceId, transfer.RootId, true, ct);
        var value = await broker.Invoke(transfer.DeviceId, "files.commit", new
        {
            root = root.RootKey, transfer.Path, transferId = transfer.Id, length = transfer.Length, transfer.Version
        }, ct, transfer.Id, connectionId: root.ConnectionId);
        return Wire.Model<FileEntry>(value);
    }

    public async Task Abandon(Review review, TransferRecord transfer, CancellationToken ct)
    {
        using var shortWait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        shortWait.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            var root = await Allow(review, transfer.DeviceId, transfer.RootId, true, shortWait.Token);
            await broker.Invoke(transfer.DeviceId, "files.abandon", new { root = root.RootKey, transferId = transfer.Id }, shortWait.Token, connectionId: root.ConnectionId);
        }
        catch (Exception error) when (error is Fault or OperationCanceledException)
        {
        }
    }

    public static void RequireVersionIfNeeded(string? version, string kind)
    {
        if (kind is "move" or "trash" or "purge" or "thumbnail" && string.IsNullOrEmpty(version))
            throw new Fault(428, "file_version_required");
        if (version is not null && (version.Length is < 1 or > 256 || version.Any(c => c < 33 || c > 126 || c is '\\' or '"')))
            throw Fault.Bad("invalid_version");
    }
}

internal sealed record TransferInput(string DeviceId, string RootId, string Kind, string? Path, long? Length, string? Version,
    IReadOnlyList<string>? Entries);
internal sealed record TransferRecord(string Id, string Owner, string DeviceId, string RootId, string Kind, string State, string Path,
    string FileName, string? Version, long Length, long Offset, long Created, long Updated, string Idempotency, string Fingerprint, string? Error)
{
    public TransferView View => new(Id, DeviceId, RootId, Kind, State, Path, FileName, Version, Length, Offset, Clock.At(Created), Clock.At(Updated), Error);
}
internal sealed record TransferView(string Id, string DeviceId, string RootId, string Kind, string State, string Path,
    string FileName, string? Version, long Length, long Offset, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? Error)
{
    public string? DownloadUrl => Kind != "upload" && State is "ready" or "completed" ? $"/api/v1/transfers/{Id}/content" : null;
}

internal sealed class TransferService(Database db, FileService files, Settings settings, ILogger<TransferService> logger)
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> writers = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> streams = new();
    private readonly SemaphoreSlim archiveSlots = new(2);
    private string ArchivePath(string id) => Path.Combine(settings.DataDirectory, "archives", $"{id}.zip");

    public async Task<(TransferRecord Transfer, bool IsNew)> Start(Review review, TransferInput body, string idempotency, CancellationToken ct)
    {
        var requestKey = Secrets.Text(idempotency, 128);
        var access = await files.Allow(review, body.DeviceId, body.RootId, body.Kind == "upload", ct);
        if (body.Kind is not ("download" or "upload" or "archive"))
            throw Fault.Bad("invalid_transfer_kind");
        FileService.RequireVersionIfNeeded(body.Version, body.Kind);
        var path = body.Kind == "archive" ? FileService.PathKey(body.Path) : FileService.EntryPath(body.Path);
        if (body.Kind == "upload" && body.Length is not (>= 0 and <= FileService.MaximumBytes))
            throw Fault.Bad("invalid_length");
        var entries = body.Kind == "archive" ? (body.Entries is { Count: <= 100 } ? body.Entries.Select(FileService.EntryPath).Distinct().ToArray()
            : body.Entries is null ? [path] : throw Fault.Bad("too_many_entries")) : [];
        if (body.Kind == "archive" && entries.Length == 0)
            throw Fault.Bad("entries_required");
        var fingerprint = Secrets.Hash(Wire.Encode(new { body.DeviceId, body.RootId, body.Kind, path, body.Length, body.Version, entries }));
        var key = new { review.Initiator, requestKey };
        var existing = await db.One<TransferRecord>("SELECT * FROM Transfers WHERE Owner=@Initiator AND Idempotency=@requestKey", key, ct);
        if (existing is not null)
            return (Same(existing, fingerprint), false);

        var state = body.Kind == "archive" ? "preparing" : "ready";
        string? version = body.Version;
        var length = body.Length ?? 0;
        if (body.Kind == "download")
        {
            var entry = await files.Stat(review, body.DeviceId, body.RootId, path, ct, connectionId: access.ConnectionId);
            if (entry.Kind != "file" || entry.Size < 0 || entry.Size > FileService.MaximumBytes)
                throw Fault.Bad("not_downloadable");
            if (version is not null && version != entry.Version)
                throw new Fault(412, "version_mismatch");
            version = entry.Version;
            length = entry.Size;
        }
        var row = new TransferRecord(Secrets.Id(), review.Initiator, body.DeviceId, body.RootId, body.Kind, state, path,
            body.Kind == "archive" ? "files.zip" : path.Split('/')[^1], version, length, 0, Clock.Now, Clock.Now,
            requestKey, fingerprint, null);
        if (body.Kind == "archive" && !archiveSlots.Wait(0))
            throw new Fault(429, "archive_limit");
        try
        {
            var inserted = await db.Mutate("""
                INSERT OR IGNORE INTO Transfers VALUES(@Id,@Owner,@DeviceId,@RootId,@Kind,@State,@Path,@FileName,@Version,@Length,@Offset,
                    @Created,@Updated,@Idempotency,@Fingerprint,@Error)
                """, row, row.Owner, row.DeviceId, "transfer.created", new { row.Id, row.Kind, row.RootId, row.Path }, ct);
            if (!inserted)
            {
                existing = await db.One<TransferRecord>("SELECT * FROM Transfers WHERE Owner=@Initiator AND Idempotency=@requestKey", key, ct)
                    ?? throw Fault.Conflict("transfer_conflict");
                var replay = Same(existing, fingerprint);
                if (body.Kind == "archive")
                    archiveSlots.Release();
                return (replay, false);
            }
        }
        catch
        {
            if (body.Kind == "archive")
                archiveSlots.Release();
            throw;
        }
        if (body.Kind == "archive")
            _ = Pack(review, row, entries, access.ConnectionId!);
        return (row, true);
    }

    public async Task<TransferRecord> Get(Review review, string id, CancellationToken ct) =>
        await db.One<TransferRecord>("SELECT * FROM Transfers WHERE Id=@id AND Owner=@Initiator",
            new { id = Secrets.Identifier(id), review.Initiator }, ct) ?? throw Fault.Missing("transfer_not_found");

    public async Task<long> Upload(Review review, string id, long offset, ReadOnlyMemory<byte> bytes, CancellationToken ct)
    {
        var transfer = await Get(review, id, ct);
        var writer = writers.GetOrAdd(transfer.DeviceId, _ => new(1));
        if (!await writer.WaitAsync(TimeSpan.FromSeconds(3), ct))
            throw new Fault(429, "device_busy");
        try
        {
            transfer = await Get(review, id, ct);
            if (transfer is not { Kind: "upload", State: "ready" })
                throw Fault.Conflict("transfer_not_writable");
            if (bytes.IsEmpty || bytes.Length > FileService.Chunk || offset < 0 || offset > transfer.Offset ||
                offset > transfer.Length - bytes.Length || offset < transfer.Offset && offset + bytes.Length > transfer.Offset)
                throw Fault.Conflict("invalid_offset");
            await files.Write(review, transfer, bytes, offset, ct);
            var next = Math.Max(transfer.Offset, offset + bytes.Length);
            await Report(transfer, next, "ready", CancellationToken.None);
            return next;
        }
        finally
        {
            writer.Release();
        }
    }

    public async Task<FileEntry> Commit(Review review, string id, CancellationToken ct)
    {
        var transfer = await Get(review, id, ct);
        var writer = writers.GetOrAdd(transfer.DeviceId, _ => new(1));
        if (!await writer.WaitAsync(TimeSpan.FromSeconds(3), ct))
            throw new Fault(429, "device_busy");
        try
        {
            transfer = await Get(review, id, ct);
            if (transfer.Kind != "upload" || transfer.State is not ("ready" or "completed") || transfer.Length != transfer.Offset)
                throw Fault.Conflict("upload_incomplete");
            if (transfer.State == "completed")
            {
                var existing = await files.Stat(review, transfer.DeviceId, transfer.RootId, transfer.Path, ct);
                return existing.Version == transfer.Version ? existing : throw new Fault(412, "version_mismatch");
            }
            var result = await files.Commit(review, transfer, ct);
            await db.Mutate("UPDATE Transfers SET State='completed',Version=@Version,Updated=@now WHERE Id=@id AND State='ready'",
                new { result.Version, now = Clock.Now, id }, review.Initiator, transfer.DeviceId, "transfer.committed", new { id }, CancellationToken.None);
            await Event(transfer, "completed", transfer.Length);
            return result;
        }
        finally
        {
            writer.Release();
        }
    }

    public async Task Cancel(Review review, string id, CancellationToken ct)
    {
        var transfer = await Get(review, id, ct);
        var writer = writers.GetOrAdd(transfer.DeviceId, _ => new(1));
        await writer.WaitAsync(ct);
        try
        {
            var changed = await db.Mutate("""
                UPDATE Transfers SET State='cancelled',Updated=@Now WHERE Id=@id AND State IN ('ready','preparing')
                """, new { id, Now = Clock.Now }, transfer.Owner, transfer.DeviceId, "transfer.cancelled", new { id }, ct);
            if (!changed)
            {
                if ((await Get(review, id, ct)).State == "cancelled")
                    return;
                throw Fault.Conflict("transfer_finished");
            }
            if (transfer.Kind == "upload")
                await files.Abandon(review, transfer, ct);
            if (transfer.Kind == "archive")
                File.Delete(ArchivePath(transfer.Id));
            await Event(transfer, "cancelled", transfer.Offset);
        }
        finally
        {
            writer.Release();
        }
    }

    public async Task Serve(HttpContext context, Review review, string id, CancellationToken ct)
    {
        var transfer = await Get(review, id, ct);
        if (transfer.Kind is not ("archive" or "download") || transfer.State is not ("ready" or "completed") || transfer.Version is null)
            throw Fault.Conflict("download_not_ready");
        var access = await files.Allow(review, transfer.DeviceId, transfer.RootId, false, ct);
        if (transfer.Kind == "download")
        {
            var source = await files.Stat(review, transfer.DeviceId, transfer.RootId, transfer.Path, ct, connectionId: access.ConnectionId);
            if (source.Version != transfer.Version || source.Size != transfer.Length)
                throw new Fault(412, "version_mismatch");
        }
        var etag = $"\"{transfer.Version}\"";
        var rangeHeader = context.Request.Headers.Range.ToString();
        var ifRange = context.Request.Headers.IfRange.ToString();
        var partial = rangeHeader.Length > 0 && (ifRange.Length == 0 || ifRange == etag);
        var (offset, length) = partial ? ParseRange(rangeHeader, transfer.Length) : (0L, transfer.Length);
        if (offset < 0)
        {
            context.Response.Headers.ContentRange = $"bytes */{transfer.Length}";
            await TypedResults.Problem(statusCode: 416, title: "range_not_satisfiable",
                extensions: new Dictionary<string, object?> { ["code"] = "range_not_satisfiable", ["traceId"] = context.TraceIdentifier })
                .ExecuteAsync(context);
            return;
        }
        var response = context.Response;
        response.Headers.ETag = etag;
        response.Headers.AcceptRanges = "bytes";
        var disposition = new Microsoft.Net.Http.Headers.ContentDispositionHeaderValue("attachment");
        disposition.SetHttpFileName(transfer.FileName);
        response.Headers.ContentDisposition = disposition.ToString();
        response.ContentType = transfer.Kind == "archive" ? "application/zip" : "application/octet-stream";
        response.ContentLength = length;
        if (partial)
        {
            response.StatusCode = 206;
            response.Headers.ContentRange = $"bytes {offset}-{offset + length - 1}/{transfer.Length}";
        }
        if (HttpMethods.IsHead(context.Request.Method))
            return;

        var slots = streams.GetOrAdd(transfer.DeviceId, _ => new(2));
        if (!slots.Wait(0))
        {
            response.ContentLength = null;
            throw new Fault(429, "stream_limit");
        }
        var lastProgress = offset;
        try
        {
            if (transfer.Kind == "archive")
            {
                if (!File.Exists(ArchivePath(transfer.Id)))
                {
                    response.ContentLength = null;
                    throw new Fault(410, "archive_expired");
                }
                await using var archive = new FileStream(ArchivePath(transfer.Id), FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete,
                    FileService.Chunk, FileOptions.Asynchronous | FileOptions.SequentialScan);
                archive.Seek(offset, SeekOrigin.Begin);
                var buffer = new byte[FileService.Chunk];
                for (var remaining = length; remaining > 0;)
                {
                    await Check(transfer, review, ct, access.ConnectionId!);
                    var got = await archive.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), ct);
                    if (got == 0)
                        throw Fault.Conflict("archive_changed");
                    await response.Body.WriteAsync(buffer.AsMemory(0, got), ct);
                    remaining -= got;
                    await Progress(offset + length - remaining, ct);
                }
            }
            else
                await files.Pump(review, transfer.DeviceId, transfer.RootId, transfer.Path, transfer.Version, offset, length, response.Body, Progress, ct, access.ConnectionId);
            await Report(transfer, offset + length, offset + length == transfer.Length ? "completed" : "ready", ct, offset);
        }
        catch
        {
            if (!response.HasStarted)
                response.ContentLength = null;
            else
                context.Abort();
            throw;
        }
        finally
        {
            slots.Release();
        }

        async Task Progress(long current, CancellationToken token)
        {
            await Check(transfer, review, token, access.ConnectionId!);
            if (current - lastProgress >= FileService.Chunk * 8L || current == offset + length)
            {
                lastProgress = current;
                await Report(transfer, current, "ready", token, offset);
            }
        }
    }

    private async Task Pack(Review review, TransferRecord transfer, string[] entries, string connectionId)
    {
        var path = ArchivePath(transfer.Id);
        var temporary = path + ".part";
        long packedBytes = 0;
        long lastProgress = 0;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using var deadline = new CancellationTokenSource(TimeSpan.FromHours(2));
            var ct = deadline.Token;
            var names = new HashSet<string>(StringComparer.Ordinal);
            long total = 0;
            int count = 0;
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                FileService.Chunk, FileOptions.Asynchronous))
            {
                using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
                foreach (var entry in entries)
                {
                    var name = entry.Length == 0 ? "" : entry.Split('/')[^1];
                    await Add(entry, name, zip, ct);
                }
            }
            await Check(transfer, review, ct, connectionId);
            File.Move(temporary, path);
            var length = new FileInfo(path).Length;
            var saved = await db.Execute("""
                UPDATE Transfers SET State='ready',Length=@length,Offset=0,Version=@version,Updated=@Now WHERE Id=@Id AND State='preparing'
                """, new { length, version = transfer.Id, Now = Clock.Now, transfer.Id }, CancellationToken.None);
            if (saved == 1)
                await Event(transfer with { Length = length }, "ready", 0);
            else
                File.Delete(path);

            async Task Add(string relative, string archiveName, ZipArchive zip, CancellationToken token)
            {
                await Check(transfer, review, token, connectionId);
                if (++count > 100_000)
                    throw new Fault(413, "archive_entry_limit");
                var entry = await files.Stat(review, transfer.DeviceId, transfer.RootId, relative, token, connectionId: connectionId);
                if (entry.Kind == "file")
                {
                    if (!names.Add(archiveName))
                        throw Fault.Conflict("archive_name_collision");
                    total = checked(total + entry.Size);
                    if (total > FileService.MaximumBytes)
                        throw new Fault(413, "archive_size_limit");
                    var initial = packedBytes;
                    await using var target = zip.CreateEntry(archiveName, CompressionLevel.Fastest).Open();
                    await files.Pump(review, transfer.DeviceId, transfer.RootId, relative, entry.Version, 0, entry.Size, target,
                        async (offset, progressToken) =>
                        {
                            packedBytes = initial + offset;
                            await Check(transfer, review, progressToken, connectionId);
                            if (packedBytes - lastProgress >= FileService.Chunk * 8L || offset == entry.Size && lastProgress == 0)
                            {
                                lastProgress = packedBytes;
                                var updated = await db.Execute("""
                                    UPDATE Transfers SET Offset=@packedBytes,Updated=@now WHERE Id=@Id AND State='preparing'
                                    """, new { transfer.Id, packedBytes, now = Clock.Now }, progressToken);
                                if (updated == 1)
                                    await Event(transfer, "preparing", packedBytes);
                            }
                        }, token, connectionId);
                }
                else if (entry.Kind == "directory")
                {
                    if (archiveName.Length > 0)
                    {
                        if (!names.Add(archiveName + "/"))
                            throw Fault.Conflict("archive_name_collision");
                        zip.CreateEntry(archiveName + "/");
                    }
                    int? offset = 0;
                    string? revision = null;
                    while (offset is { } start)
                    {
                        var page = await files.List(review, transfer.DeviceId, transfer.RootId, relative, true, start, 100, revision, token, connectionId: connectionId);
                        foreach (var child in page.Items)
                            await Add(FileService.EntryPath(child.Path),
                                archiveName.Length == 0 ? child.Name : $"{archiveName}/{child.Name}", zip, token);
                        offset = page.NextOffset;
                        revision = page.Revision;
                    }
                }
            }
        }
        catch (Exception error)
        {
            try
            {
                File.Delete(temporary);
                File.Delete(path);
                await db.Execute("UPDATE Transfers SET State='failed',Error=@Error,Updated=@Now WHERE Id=@Id AND State='preparing'",
                    new { Error = (error as Fault)?.Code ?? "archive_failed", Now = Clock.Now, transfer.Id }, CancellationToken.None);
                await Event(transfer, "failed", 0);
            }
            catch (Exception persistence)
            {
                logger.LogError(persistence, "Archive state update failed for {TransferId}", transfer.Id);
            }
        }
        finally
        {
            archiveSlots.Release();
        }
    }

    private async Task Check(TransferRecord transfer, Review review, CancellationToken ct, string connectionId)
    {
        await files.Allow(review, transfer.DeviceId, transfer.RootId, false, ct, connectionId);
        var state = await db.One<string>("SELECT State FROM Transfers WHERE Id=@Id", new { transfer.Id }, ct);
        if (state is "cancelled" or "failed" or null)
            throw Fault.Conflict("transfer_cancelled");
    }

    private async Task Report(TransferRecord transfer, long offset, string state, CancellationToken ct, long start = 0)
    {
        var now = Clock.Now;
        var changed = await db.Execute("""
            UPDATE Transfers SET Offset=MAX(Offset,@offset),State=CASE WHEN State='completed' THEN State ELSE @state END,Updated=@now
            WHERE Id=@Id AND @start<=Offset AND State IN ('ready','completed') AND (Offset<@offset OR State<>@state AND @state='completed')
            """, new { start, offset, state, now, transfer.Id }, ct);
        if (changed == 1)
            await Event(transfer, state, offset);
    }

    private Task Event(TransferRecord transfer, string state, long offset) =>
        db.AppendEvent(transfer.DeviceId, "transfers.changed", Wire.Element(new { id = transfer.Id, state, offset, transfer.Length }),
            CancellationToken.None);

    private static TransferRecord Same(TransferRecord row, string fingerprint) =>
        row.Fingerprint == fingerprint ? row : throw Fault.Conflict("idempotency_conflict");

    private static (long Offset, long Size) ParseRange(string header, long length)
    {
        if (!Microsoft.Net.Http.Headers.RangeHeaderValue.TryParse(header, out var ranges) ||
            ranges.Unit != "bytes" || ranges.Ranges.Count != 1 || length == 0)
            return (-1, 0);
        var range = ranges.Ranges.Single();
        if (range.From is not { } start)
            return range.To is > 0 ? (Math.Max(0, length - range.To.Value), Math.Min(length, range.To.Value)) : (-1, 0);
        var end = Math.Min(range.To ?? (length - 1), length - 1);
        return start <= end ? (start, end - start + 1) : (-1, 0);
    }
}
