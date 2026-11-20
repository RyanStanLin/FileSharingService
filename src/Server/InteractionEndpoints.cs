using System.Text.Json;
using System.Text.Json.Serialization;

namespace FileSharing;

/// <summary>A device-local choice with a stable ID for the response.</summary>
internal sealed record DialogChoice(string Id, string Label);

/// <summary>Content and deadline for an attributed macOS dialog with optional text entry.</summary>
internal sealed record DialogRequest(string Title, string Message, string? Icon, IReadOnlyList<DialogChoice> Choices,
    bool AskText = false, bool TextRequired = false, int TimeoutSeconds = 90,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool RequireLocalAuthentication = false,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool MaskText = false);

/// <summary>Content for one local macOS notification.</summary>
internal sealed record LocalNotificationRequest(string Title, string Message, bool Sound = false);

internal static class InteractionEndpoints
{
    internal const string Dialog = "interaction.dialog";
    internal const string MaskedDialog = "interaction.dialog.masked";
    internal const string Notification = "interaction.notification";

    public static void Map(RouteGroupBuilder devices)
    {
        var interactions = devices.MapGroup("/interactions").WithTags("Device interactions");
        interactions.MapPost("/dialogs", Present)
            .WithSummary("Ask the active Mac user to make a choice or submit text, with optional masking");
        interactions.MapPost("/notifications", Notify).WithSummary("Schedule a local notification in macOS Notification Center");
    }

    private static async Task<Accepted<JobView>> Present(string id, DialogRequest body, HttpContext context, ReviewService reviews,
        DeviceService devices, JobService jobs, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        await devices.Require(id, ct);
        if (body.Icon is not (null or "info" or "warning" or "question" or "stop") ||
            body.TimeoutSeconds is < 10 or > 120 || body.Choices is not { Count: >= 1 and <= 3 } ||
            (body.TextRequired || body.MaskText) && !body.AskText || body.RequireLocalAuthentication && body.AskText)
            throw Fault.Bad("invalid_dialog");
        var choices = body.Choices.Select(choice =>
        {
            if (choice?.Id is not { Length: >= 1 and <= 32 } value ||
                !value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
                throw Fault.Bad("invalid_dialog_choice");
            return new DialogChoice(value, Secrets.Text(choice.Label, 40));
        }).ToArray();
        if (choices.Select(x => x.Id).Distinct(StringComparer.Ordinal).Count() != choices.Length)
            throw Fault.Bad("invalid_dialog_choice");
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
            var result = Wire.Model<DialogResult>(payload);
            if (result.Outcome == "submitted")
            {
                if (!dialog.Choices.Any(x => x.Id == result.ChoiceId) ||
                    result.Text is { Length: > 1024 } || result.Text?.Any(char.IsControl) == true ||
                    (!dialog.AskText && result.Text is not null) || (dialog.TextRequired && string.IsNullOrWhiteSpace(result.Text)) ||
                    (dialog.RequireLocalAuthentication ? result.LocallyAuthenticated != true : result.LocallyAuthenticated is not null))
                    throw Fault.Bad("invalid_dialog_result");
            }
            else if (result.Outcome is not ("dismissed" or "expired") || result.ChoiceId is not null || result.Text is not null ||
                     result.LocallyAuthenticated is not null)
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

    private static string Message(string? value, int maximum)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text) || text.Length > maximum || text.Any(c => char.IsControl(c) && c != '\n'))
            throw Fault.Bad("invalid_text");
        return text;
    }

    private sealed record DialogResult(string Outcome, string? ChoiceId, string? Text, DateTimeOffset RespondedAt,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? LocallyAuthenticated);
    private sealed record NotificationResult(string Status, DateTimeOffset ScheduledAt);
}
