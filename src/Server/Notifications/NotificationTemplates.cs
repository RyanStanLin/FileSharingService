using System.Globalization;
using System.Text;

namespace FileSharing;

internal sealed class NotificationTemplates
{
    public static void Validate(NotificationTemplate? template, HashSet<string> variables)
    {
        if (template is null || string.IsNullOrWhiteSpace(template.Body) || template.Body.Length > 2800 ||
            template.Title is { Length: > 256 })
            throw Fault.Bad("invalid_notification_template");
        _ = Expand(template.Title ?? "", variables, null, null);
        _ = Expand(template.Body, variables, null, null);
    }

    public static NotificationPreview Preview(NotificationPreviewRequest request)
    {
        var type = NotificationCatalog.Require(request.Event);
        var variables = NotificationCatalog.Variables([type]);
        Validate(request.Template, variables);
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (request.Context is { } context)
        {
            if (context.Count > variables.Count)
                throw Fault.Bad("invalid_notification_context");
            foreach (var (key, value) in context)
            {
                if (!variables.Contains(key) || key.StartsWith("event.", StringComparison.Ordinal) ||
                    value is null or { Length: > 3000 } || NotificationText.HasUnsupportedControls(value))
                    throw Fault.Bad("invalid_notification_context");
                values.Add(key, value);
            }
        }
        values.Add("event.type", type.Type);
        values.Add("event.occurredAt", Time(DateTimeOffset.UtcNow));
        return Render(request.Template, values);
    }

    public static NotificationPreview Render(NotificationTemplate template, IReadOnlyDictionary<string, string> context)
    {
        var missing = new HashSet<string>(StringComparer.Ordinal);
        var title = Expand(template.Title ?? "", null, context, missing);
        var body = Expand(template.Body, null, context, missing);
        return new(new NotificationMessage(
            string.IsNullOrWhiteSpace(title) ? "FileSharing" : NotificationText.Limit(title, NotificationText.TitleBytes),
            string.IsNullOrWhiteSpace(body) ? context["event.type"] : NotificationText.Limit(body, NotificationText.BodyBytes)),
            missing.Order(StringComparer.Ordinal).ToArray());
    }

    public static string Time(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private static string Expand(string text, HashSet<string>? allowed, IReadOnlyDictionary<string, string>? context,
        HashSet<string>? missing)
    {
        if (NotificationText.HasUnsupportedControls(text))
            throw Fault.Bad("invalid_notification_template");
        var output = new StringBuilder(text.Length);
        var index = 0;
        var variables = 0;
        while (index < text.Length)
        {
            var opening = text.IndexOf("{{", index, StringComparison.Ordinal);
            var closing = text.IndexOf("}}", index, StringComparison.Ordinal);
            if (opening < 0)
            {
                if (closing >= 0)
                    throw Fault.Bad("invalid_notification_template");
                output.Append(text, index, text.Length - index);
                break;
            }
            if (++variables > 48 || closing < opening)
                throw Fault.Bad("invalid_notification_template");
            output.Append(text, index, opening - index);
            var name = text[(opening + 2)..closing].Trim();
            if (allowed is not null && !allowed.Contains(name))
                throw Fault.Bad("unknown_notification_variable");
            if (context is not null)
            {
                if (context.TryGetValue(name, out var value))
                    output.Append(value);
                else
                    missing!.Add(name);
            }
            index = closing + 2;
        }
        return output.ToString();
    }
}
