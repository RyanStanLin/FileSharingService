using System.Text.Json;
using Dapper;

namespace FileSharing;

/// <summary>One encoded stdout or stderr segment. Indices are one-based and scoped to the job.</summary>
internal sealed record JobOutputPart(long Index, string Stream, string Data);

/// <summary>Ordered output segments and the last index available to resume polling.</summary>
internal sealed record JobOutputPage(IReadOnlyList<JobOutputPart> Items, long Cursor);

internal sealed class JobOutputs(Database db)
{
    public async Task<JobOutputPage> Read(string id, string owner, int after, CancellationToken ct)
    {
        if (after is < 0 or > 64)
            throw Fault.Bad("invalid_output_cursor");
        if (await db.One<int>("SELECT EXISTS(SELECT 1 FROM Jobs WHERE Id=@id AND Owner=@owner)", new { id, owner }, ct) == 0)
            throw Fault.Missing();
        var rows = await db.List<JobOutputPart>("""
            SELECT Ordinal AS [Index],Stream,Data FROM JobOutput WHERE JobId=@id AND Ordinal>@after ORDER BY Ordinal
            """, new { id, after }, ct);
        return new(rows, rows.LastOrDefault()?.Index ?? after);
    }

    public Task Write(JobRecord job, JsonElement payload, CancellationToken ct)
    {
        var part = Wire.Model<JobOutputPart>(payload);
        if (part.Index is < 1 or > 64 || part.Stream is not ("stdout" or "stderr") ||
            part.Data is not { Length: >= 4 and <= 5464 })
            throw Fault.Bad("invalid_job_output");
        Span<byte> buffer = stackalloc byte[4096];
        if (!Convert.TryFromBase64String(part.Data, buffer, out var bytes) || bytes == 0)
            throw Fault.Bad("invalid_job_output");
        var data = Convert.ToBase64String(buffer[..bytes]);
        return db.Write(async (connection, tx) =>
        {
            var changed = await connection.ExecuteAsync(new CommandDefinition("""
                INSERT OR IGNORE INTO JobOutput(JobId,Ordinal,Stream,Data)
                SELECT @Id,@Index,@Stream,@data WHERE EXISTS(SELECT 1 FROM Jobs WHERE Id=@Id AND State='queued')
                """, new { job.Id, part.Index, part.Stream, data }, tx, cancellationToken: ct));
            if (changed == 1)
            {
                await connection.ExecuteAsync(new CommandDefinition("""
                    INSERT INTO Events(DeviceId,Topic,At,Payload) VALUES(@DeviceId,'jobs.output',@now,@value)
                    """, new { job.DeviceId, now = Clock.Now, value = Wire.Encode(new { jobId = job.Id, part.Index, part.Stream, data }) },
                    tx, cancellationToken: ct));
            }
            return changed;
        });
    }
}
