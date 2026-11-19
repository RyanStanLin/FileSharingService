using System.Security.Cryptography;
using System.Text;

namespace FileSharing;

internal sealed class GatewayCredentialVault(IConfiguration config)
{
    private readonly byte[]? key = ReadKey(config["FileSharing:GatewayCredentialKey"]);

    public bool Enabled => key is not null;

    public string? Seal(string id, string password)
    {
        if (key is null)
            return null;
        Span<byte> plain = stackalloc byte[128];
        var count = Encoding.UTF8.GetBytes(password, plain);
        var envelope = new byte[12 + 16 + count];
        try
        {
            RandomNumberGenerator.Fill(envelope.AsSpan(0, 12));
            using var cipher = new AesGcm(key, 16);
            cipher.Encrypt(envelope.AsSpan(0, 12), plain[..count], envelope.AsSpan(28),
                envelope.AsSpan(12, 16), Encoding.UTF8.GetBytes(id));
            return Convert.ToBase64String(envelope);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public string Reveal(string id, string? value)
    {
        if (key is null || value is null)
            throw Fault.Conflict("password_reveal_unavailable");
        Span<byte> plain = stackalloc byte[128];
        try
        {
            var envelope = Convert.FromBase64String(value);
            if (envelope.Length is < 44 or > 156)
                throw Fault.Conflict("password_reveal_unavailable");
            using var cipher = new AesGcm(key, 16);
            var target = plain[..(envelope.Length - 28)];
            cipher.Decrypt(envelope.AsSpan(0, 12), envelope.AsSpan(28), envelope.AsSpan(12, 16), target,
                Encoding.UTF8.GetBytes(id));
            return Encoding.UTF8.GetString(target);
        }
        catch (Exception error) when (error is CryptographicException or FormatException)
        {
            throw Fault.Conflict("password_reveal_unavailable");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    private static byte[]? ReadKey(string? value)
    {
        if (string.IsNullOrEmpty(value))
            return null;
        if (value.Length != 64 || !value.All(char.IsAsciiHexDigit))
            throw new InvalidOperationException("FileSharing:GatewayCredentialKey must contain 64 hexadecimal characters.");
        return Convert.FromHexString(value);
    }
}
