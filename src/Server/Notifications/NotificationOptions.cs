namespace FileSharing;

internal sealed class NotificationOptions
{
    public const string DefaultBarkOrigin = "https://api.day.app";
    public static readonly Uri DefaultTelegramOrigin = new("https://api.telegram.org");
    private readonly HashSet<string> barkOrigins;
    private readonly bool loopbackDevelopment;

    public NotificationOptions(IConfiguration configuration, Settings settings)
    {
        loopbackDevelopment = settings.LoopbackDevelopment;
        barkOrigins = new(StringComparer.Ordinal) { DefaultBarkOrigin };
        foreach (var origin in (configuration["FileSharing:Notifications:BarkOrigins"] ?? "")
                 .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (ParseOrigin(origin) is not { } allowed)
                throw new InvalidOperationException("FileSharing:Notifications:BarkOrigins must contain HTTPS origins.");
            barkOrigins.Add(allowed);
        }
        TelegramOrigin = DefaultTelegramOrigin;
        if (loopbackDevelopment && configuration["FileSharing:Notifications:TestTelegramOrigin"] is { Length: > 0 } test)
        {
            if (ParseOrigin(test) is not { } origin || !new Uri(origin).IsLoopback)
                throw new InvalidOperationException("The development Telegram endpoint must be a loopback origin.");
            TelegramOrigin = new Uri(origin);
        }
    }

    public Uri TelegramOrigin { get; }

    public string BarkOrigin(string? value)
    {
        if (value is null)
            return DefaultBarkOrigin;
        var origin = ParseOrigin(value) ?? throw Fault.Bad("invalid_bark_origin");
        return barkOrigins.Contains(origin) ? origin : throw Fault.Bad("bark_origin_not_allowed");
    }

    public bool AllowsBark(string origin) => barkOrigins.Contains(origin);

    private string? ParseOrigin(string value)
    {
        if (value.Length > 512 || value.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c == '\\') ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Host.Length == 0 ||
            uri.AbsolutePath != "/" || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0 ||
            (uri.Scheme != Uri.UriSchemeHttps &&
             !(loopbackDevelopment && uri.IsLoopback && uri.Scheme == Uri.UriSchemeHttp)))
            return null;
        return uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped);
    }
}
