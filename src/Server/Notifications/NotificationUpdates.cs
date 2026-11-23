using System.Globalization;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

internal sealed class NotificationUpdates(Database db)
{
    public const string Topic = "notifications.changed";

    public static Task Record(SqliteConnection connection, SqliteTransaction tx, string? device,
        NotificationUpdate update, CancellationToken ct) =>
        connection.ExecuteAsync(new CommandDefinition("INSERT INTO NotificationUpdates(DeviceId,At,Payload) VALUES(@device,@at,@payload)",
            new { device, at = Clock.Now, payload = Wire.Encode(update) }, tx, cancellationToken: ct));

    public Task<long> Head(CancellationToken ct) =>
        db.One<long>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='NotificationUpdates'),0)", null, ct);

    public async Task EnsureCursor(long after, CancellationToken ct)
    {
        if (after == 0)
            return;
        var head = await Head(ct);
        var first = await db.One<long>("SELECT COALESCE(MIN(Sequence),0) FROM NotificationUpdates", null, ct);
        if (after > head || after < (first == 0 ? head : first - 1))
            throw new Fault(410, "notification_resync_required");
    }

    public async Task<EventsPage> Read(long after, int take, CancellationToken ct)
    {
        var rows = await db.List<UpdateRow>("""
            SELECT Sequence,DeviceId,At,Payload FROM NotificationUpdates WHERE Sequence>@after ORDER BY Sequence LIMIT @size
            """, new { after, size = take + 1 }, ct);
        var items = rows.Take(take).Select(x => new EventView(x.Sequence.ToString(CultureInfo.InvariantCulture),
            x.DeviceId, Topic, Clock.At(x.At), Wire.Parse(x.Payload))).ToArray();
        return new(items, items.LastOrDefault()?.Sequence ?? after.ToString(CultureInfo.InvariantCulture), rows.Count > take);
    }

    private sealed record UpdateRow(long Sequence, string? DeviceId, long At, string Payload);
}
