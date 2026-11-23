using System.Text.Json;
using System.Text.Json.Serialization;

namespace FileSharing;

/// <summary>A device-local choice with a stable ID for the response.</summary>
internal sealed record DialogChoice(string Id, string Label);

/// <summary>Configuration for one native text field. Disabled fields display their default value.</summary>
internal sealed record DialogTextField(string Id, string? HintText = null, string? DefaultText = null,
    bool Disabled = false, bool Required = false, bool MaskText = false);

/// <summary>Content and deadline for an attributed macOS dialog with optional text entry.</summary>
internal sealed record DialogRequest(string Title, string Message, string? Icon, IReadOnlyList<DialogChoice> Choices,
    bool AskText = false, bool TextRequired = false, int TimeoutSeconds = 90,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool RequireLocalAuthentication = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool MaskText = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<DialogTextField>? TextFields = null);

/// <summary>Content for one local macOS notification.</summary>
internal sealed record LocalNotificationRequest(string Title, string Message, bool Sound = false);

/// <summary>The accepted device response to a native dialog.</summary>
internal sealed record DialogResult(string Outcome, string? ChoiceId, string? Text, DateTimeOffset RespondedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? LocallyAuthenticated,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Dictionary<string, string>? TextValues);

internal static class InteractionEndpoints
{
    internal const string Dialog = "interaction.dialog";
    internal const string MaskedDialog = "interaction.dialog.masked";
    internal const string FormDialog = "interaction.dialog.form";
    internal const string Notification = "interaction.notification";

    public static void Map(RouteGroupBuilder devices)
    {
        var interactions = devices.MapGroup("/interactions").WithTags("Device interactions");
        interactions.MapPost("/dialogs", Present)
            .WithSummary("Ask the active Mac user to choose an option and optionally submit configurable text fields")
            .ProducesProblem(400);
        interactions.MapPost("/notifications", Notify).WithSummary("Schedule a local notification in macOS Notification Center");
    }

    private static async Task<Accepted<JobView>> Present(string id, DialogRequest body, HttpContext context, ReviewService reviews,
        DeviceService devices, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        await devices.Require(id, ct);
        if (body.Icon is not (null or "info" or "warning" or "question" or "stop") ||
            body.TimeoutSeconds is < 10 or > 120 || body.Choices is not { Count: >= 1 and <= 3 } ||
            (body.TextRequired || body.MaskText) && !body.AskText || body.RequireLocalAuthentication && body.AskText ||
            body.TextFields is not null && (body.AskText || body.RequireLocalAuthentication))
            throw Fault.Bad("invalid_dialog");
        var choices = body.Choices.Select(choice =>
        {
            if (choice is null || !ValidIdentifier(choice.Id))
                throw Fault.Bad("invalid_dialog_choice");
            return new DialogChoice(choice.Id, Secrets.Text(choice.Label, 40));
        }).ToArray();
        if (choices.Select(x => x.Id).Distinct(StringComparer.Ordinal).Count() != choices.Length)
            throw Fault.Bad("invalid_dialog_choice");
        ValidateFields(body.TextFields);
        var request = body with { Title = Secrets.Text(body.Title, 100), Message = Message(body.Message, 1000),
            Choices = choices, Icon = body.Icon ?? "info" };
        var job = await jobs.Start(review, id, Dialog, request, ct);
        return TypedResults.Accepted($"/api/v1/jobs/{job.Id}", job);
    }

    private static async Task<Accepted<JobView>> Notify(string id, LocalNotificationRequest body, HttpContext context, ReviewService reviews,
        DeviceService devices, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        await devices.Require(id, ct);
        var request = body with { Title = Secrets.Text(body.Title, 100), Message = Message(body.Message, 500) };
        var job = await jobs.Start(review, id, Notification, request, ct);
        return TypedResults.Accepted($"/api/v1/jobs/{job.Id}", job);
    }

    internal static JsonElement Result(object request, JsonElement payload)
    {
        if (request is DialogRequest dialog)
        {
            if (dialog.RequireLocalAuthentication && (payload.ValueKind != JsonValueKind.Object ||
                payload.EnumerateObject().Any(property => property.Name is not
                    ("outcome" or "choiceId" or "text" or "respondedAt" or "locallyAuthenticated"))))
                throw Fault.Bad("invalid_dialog_result");
            DialogResult result;
            try
            {
                result = Wire.Model<DialogResult>(payload);
            }
            catch (JsonException)
            {
                throw Fault.Bad("invalid_dialog_result");
            }
            if (result.Outcome == "submitted")
            {
                if (!dialog.Choices.Any(x => x.Id == result.ChoiceId) ||
                    result.Text is { Length: > 1024 } || result.Text?.Any(char.IsControl) == true ||
                    (!dialog.AskText && result.Text is not null) || (dialog.TextRequired && string.IsNullOrWhiteSpace(result.Text)) ||
                    (dialog.RequireLocalAuthentication ? result.LocallyAuthenticated != true : result.LocallyAuthenticated is not null))
                    throw Fault.Bad("invalid_dialog_result");
                ValidateFieldValues(dialog.TextFields, result.TextValues, payload);
            }
            else if (result.Outcome is not ("dismissed" or "expired") || result.ChoiceId is not null || result.Text is not null ||
                     result.LocallyAuthenticated is not null || result.TextValues is not null)
                throw Fault.Bad("invalid_dialog_result");
            if (result.RespondedAt == default)
                throw Fault.Bad("invalid_dialog_result");
            return Wire.Element(result);
        }
        if (request is LocalNotificationRequest)
        {
            var result = Wire.Model<NotificationResult>(payload);
            if (result.Status != "scheduled" || result.ScheduledAt == default)
                throw Fault.Bad("invalid_notification_result");
            return Wire.Element(result);
        }
        return payload;
    }

    private static bool ValidIdentifier(string? id) =>
        id is { Length: >= 1 and <= 32 } && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static bool ValidText(string? text, int maximum) =>
        text is not null && text.Length <= maximum && !text.Any(char.IsControl);

    private static void ValidateFields(IReadOnlyList<DialogTextField>? fields)
    {
        if (fields is null)
            return;
        if (fields.Count is < 1 or > 6)
            throw Fault.Bad("invalid_dialog_fields");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in fields)
        {
            if (field is null || !ValidIdentifier(field.Id) || !ids.Add(field.Id) ||
                field.HintText is not null && !ValidText(field.HintText, 120) ||
                field.DefaultText is not null && !ValidText(field.DefaultText, 1024))
                throw Fault.Bad("invalid_dialog_fields");
        }
    }

    private static void ValidateFieldValues(IReadOnlyList<DialogTextField>? fields, Dictionary<string, string>? values, JsonElement payload)
    {
        if (fields is null)
        {
            if (values is not null)
                throw Fault.Bad("invalid_dialog_result");
            return;
        }
        var enabled = fields.Where(field => !field.Disabled).ToArray();
        if (values is null || values.Count != enabled.Length || payload.GetProperty("textValues").EnumerateObject().Count() != values.Count)
            throw Fault.Bad("invalid_dialog_result");
        foreach (var field in enabled)
        {
            if (!values.TryGetValue(field.Id, out var value) || !ValidText(value, 1024) ||
                field.Required && string.IsNullOrWhiteSpace(value))
                throw Fault.Bad("invalid_dialog_result");
        }
    }

    private static string Message(string? value, int maximum)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text.Length > maximum || text.Any(c => char.IsControl(c) && c != '\n'))
            throw Fault.Bad("invalid_text");
        return text;
    }

    private sealed record NotificationResult(string Status, DateTimeOffset ScheduledAt);
}
