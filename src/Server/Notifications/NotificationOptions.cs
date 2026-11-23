using System.Security.Cryptography;
using System.Text;

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

internal sealed class NotificationVault(IConfiguration configuration)
{
    private const int NonceLength = 12;
    private const int TagLength = 16;
    private const int HeaderLength = NonceLength + TagLength;
    private readonly byte[]? key = ReadKey(configuration["FileSharing:Notifications:CredentialKey"]);

    public bool Enabled => key is not null;

    public string Seal(string id, string kind, string credential)
    {
        if (key is null)
            throw Fault.Unavailable("notification_vault_unconfigured");

        var envelope = new byte[HeaderLength + credential.Length];
        Span<byte> plain = stackalloc byte[credential.Length];
        Encoding.ASCII.GetBytes(credential, plain);
        try
        {
            RandomNumberGenerator.Fill(envelope.AsSpan(0, NonceLength));
            using var cipher = new AesGcm(key, TagLength);
            cipher.Encrypt(envelope.AsSpan(0, NonceLength), plain, envelope.AsSpan(HeaderLength),
                envelope.AsSpan(NonceLength, TagLength), Context(id, kind));
            return Convert.ToBase64String(envelope);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public string Open(NotificationChannelRow channel)
    {
        if (key is null)
            throw Fault.Unavailable("notification_vault_unconfigured");

        Span<byte> plain = stackalloc byte[160];
        try
        {
            Span<byte> envelope = stackalloc byte[HeaderLength + 160];
            if (!Convert.TryFromBase64String(channel.SecretCipher, envelope, out var count) || count <= HeaderLength)
                throw Fault.Conflict("notification_credential_unavailable");
            var plaintext = plain[..(count - HeaderLength)];
            using var cipher = new AesGcm(key, TagLength);
            cipher.Decrypt(envelope[..NonceLength], envelope[HeaderLength..count], envelope[NonceLength..HeaderLength],
                plaintext, Context(channel.Id, channel.Kind));
            return Encoding.ASCII.GetString(plaintext);
        }
        catch (CryptographicException)
        {
            throw Fault.Conflict("notification_credential_unavailable");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    private static byte[] Context(string id, string kind) => Encoding.ASCII.GetBytes($"filesharing.notifications:v1:{kind}:{id}");

    private static byte[]? ReadKey(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return null;
        if (text.Length != 64 || !text.All(char.IsAsciiHexDigit))
            throw new InvalidOperationException("FileSharing:Notifications:CredentialKey must contain 64 hexadecimal characters.");
        return Convert.FromHexString(text);
    }
}
