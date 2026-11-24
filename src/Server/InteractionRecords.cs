using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.Data.Sqlite;

namespace FileSharing;

/// <summary>A clipboard change and the optional opaque text supplied by the agent.</summary>
internal sealed record ClipboardRecord(string Id, string DeviceId, string Event, DateTimeOffset OccurredAt,
    DateTimeOffset RecordedAt, string? Content);

/// <summary>Metadata for one archived dialog response.</summary>
internal sealed record DialogRecord(string Id, string Sequence, string DeviceId, string? Title, string Outcome, string? ChoiceId,
    DateTimeOffset CreatedAt, DateTimeOffset RecordedAt);

/// <summary>The input and masking configuration for one archived dialog field.</summary>
internal sealed record ArchivedDialogField(string Id, string? HintText, bool Disabled, bool Required, bool MaskText);

/// <summary>The original display context and field configuration of an archived dialog.</summary>
internal sealed record ArchivedDialogRequest(string Title, string Message, IReadOnlyList<DialogChoice> Choices,
    bool AskText, bool TextRequired, bool MaskText, IReadOnlyList<ArchivedDialogField>? TextFields,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool RequireLocalAuthentication = false);

/// <summary>A dialog record with its validated reply and available request context.</summary>
internal sealed record DialogRecordDetail(DialogRecord Record, ArchivedDialogRequest? Request, DialogResult Result);

internal sealed record ClipboardRecordRow(long Sequence, string DeviceId, string Event, string OccurredAt, long RecordedAt, string? Content)
{
    public ClipboardRecord View => new(Sequence.ToString(CultureInfo.InvariantCulture), DeviceId, Event,
        DateTimeOffset.Parse(OccurredAt, CultureInfo.InvariantCulture).ToUniversalTime(), Clock.At(RecordedAt), Content);
}

internal record DialogRecordRow(long Sequence, string Id, string DeviceId, string? Title, string Outcome, string? ChoiceId,
    long Created, long Finished)
{
    public DialogRecord View => new(Id, Sequence.ToString(CultureInfo.InvariantCulture), DeviceId, Title, Outcome, ChoiceId,
        Clock.At(Created), Clock.At(Finished));
}

internal sealed record DialogRecordDetailRow(long Sequence, string Id, string DeviceId, string? Title, string Outcome,
    string? ChoiceId, long Created, long Finished, string? Request, string Result)
    : DialogRecordRow(Sequence, Id, DeviceId, Title, Outcome, ChoiceId, Created, Finished)
{
    public DialogRecordDetail Detail => new(View,
        Request is null ? null : Wire.Model<ArchivedDialogRequest>(Wire.Parse(Request)), Wire.Model<DialogResult>(Wire.Parse(Result)));
}

internal static class InteractionRecords
{
    internal const string ClipboardEvent = "clipboard.changed";

    internal static Task AddClipboard(SqliteConnection connection, SqliteTransaction tx, long sequence, string device, string frameId,
        DateTimeOffset occurredAt, string? content, long now, CancellationToken ct) =>
        connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO ClipboardRecords(Sequence,DeviceId,FrameId,OccurredAt,RecordedAt,Content)
            VALUES(@sequence,@device,@frameId,@timestamp,@now,@content)
            """, new { sequence, device, frameId, timestamp = occurredAt.ToString("O", CultureInfo.InvariantCulture), now, content }, tx,
            cancellationToken: ct));

    internal static Task AddDialog(SqliteConnection connection, SqliteTransaction tx, JobRecord job, DialogRequest request,
        JsonElement result, long stop)
    {
        var context = new ArchivedDialogRequest(request.Title, request.Message, request.Choices, request.AskText,
            request.TextRequired, request.MaskText, request.TextFields?.Select(field => new ArchivedDialogField(
                field.Id, field.HintText, field.Disabled, field.Required, field.MaskText)).ToArray(), request.RequireLocalAuthentication);
        return connection.ExecuteAsync(new CommandDefinition("""
            INSERT INTO DialogRecords(Id,DeviceId,Owner,Title,Outcome,ChoiceId,Created,Finished,Request,Result)
            VALUES(@Id,@DeviceId,@Owner,@Title,@outcome,@choice,@Created,@stop,@context,@result)
            """, new { job.Id, job.DeviceId, job.Owner, request.Title, job.Created, stop, context = Wire.Encode(context),
                outcome = result.GetProperty("outcome").GetString(), choice = result.GetProperty("choiceId").GetString(),
                result = result.GetRawText() }, tx));
    }

    internal const string Migration = """
        CREATE TABLE ClipboardRecords(
            Sequence INTEGER PRIMARY KEY, DeviceId TEXT NOT NULL REFERENCES Devices(Id), FrameId TEXT,
            Event TEXT NOT NULL DEFAULT 'clipboard.changed' CHECK(Event='clipboard.changed'), OccurredAt TEXT NOT NULL,
            RecordedAt INTEGER NOT NULL, Content TEXT NOT NULL DEFAULT 'N/A' CHECK(Content='N/A'));
        CREATE INDEX ClipboardRecordsByDevice ON ClipboardRecords(DeviceId,Sequence);
        CREATE UNIQUE INDEX ClipboardRecordsByFrame ON ClipboardRecords(DeviceId,FrameId) WHERE FrameId IS NOT NULL;
        INSERT INTO ClipboardRecords(Sequence,DeviceId,OccurredAt,RecordedAt)
        SELECT Sequence,DeviceId,json_extract(Payload,'$.occurredAt'),At FROM Events
        WHERE Topic='clipboard.changed' AND CASE WHEN json_valid(Payload) THEN
            json_extract(Payload,'$.occurredAt') GLOB '????-??-??T??:??:??*'
            AND julianday(json_extract(Payload,'$.occurredAt')) IS NOT NULL
            ELSE 0 END;

        CREATE TABLE DialogRecords(
            Sequence INTEGER PRIMARY KEY AUTOINCREMENT, Id TEXT NOT NULL UNIQUE, DeviceId TEXT NOT NULL REFERENCES Devices(Id),
            Owner TEXT NOT NULL, Title TEXT, Outcome TEXT NOT NULL CHECK(Outcome IN ('submitted','dismissed','expired')),
            ChoiceId TEXT, Created INTEGER NOT NULL, Finished INTEGER NOT NULL, Request TEXT, Result TEXT NOT NULL);
        CREATE INDEX DialogRecordsByDeviceOwner ON DialogRecords(DeviceId,Owner,Sequence);
        INSERT INTO DialogRecords(Id,DeviceId,Owner,Outcome,ChoiceId,Created,Finished,Result)
        SELECT Id,DeviceId,Owner,json_extract(Result,'$.outcome'),json_extract(Result,'$.choiceId'),Created,Finished,Result
        FROM Jobs
        WHERE Kind='interaction.dialog' AND State='completed' AND Finished IS NOT NULL AND CASE WHEN json_valid(Result) THEN
            json_extract(Result,'$.outcome') IN ('submitted','dismissed','expired') ELSE 0 END
        ORDER BY Finished,Id;
        """;

    internal const string ClipboardContentMigration = """
        CREATE TABLE ClipboardRecordsNext(
            Sequence INTEGER PRIMARY KEY, DeviceId TEXT NOT NULL REFERENCES Devices(Id), FrameId TEXT,
            Event TEXT NOT NULL DEFAULT 'clipboard.changed' CHECK(Event='clipboard.changed'), OccurredAt TEXT NOT NULL,
            RecordedAt INTEGER NOT NULL, Content TEXT);
        INSERT INTO ClipboardRecordsNext(Sequence,DeviceId,FrameId,Event,OccurredAt,RecordedAt,Content)
        SELECT Sequence,DeviceId,FrameId,Event,OccurredAt,RecordedAt,Content FROM ClipboardRecords;
        DROP TABLE ClipboardRecords;
        ALTER TABLE ClipboardRecordsNext RENAME TO ClipboardRecords;
        CREATE INDEX ClipboardRecordsByDevice ON ClipboardRecords(DeviceId,Sequence);
        CREATE UNIQUE INDEX ClipboardRecordsByFrame ON ClipboardRecords(DeviceId,FrameId) WHERE FrameId IS NOT NULL;
        """;
}
