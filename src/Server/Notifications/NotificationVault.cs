using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace FileSharing;

internal sealed class NotificationVault
{
    private const int KeyLength = 32;
    private const int NonceLength = 12;
    private const int TagLength = 16;
    private const int HeaderLength = NonceLength + TagLength;
    private readonly Database database;
    private readonly string keyPath;
    private byte[]? key;

    public NotificationVault(IConfiguration configuration, Settings settings, Database database, ILogger<NotificationVault> logger)
    {
        this.database = database;
        keyPath = Path.Combine(settings.DataDirectory, "notification-credential-key");
        key = ReadConfiguredKey(configuration["FileSharing:Notifications:CredentialKey"]);
        if (key is not null)
            return;

        try
        {
            key = ReadStoredKey();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("The stored notification credential key could not be read");
        }
    }

    public bool Enabled => Volatile.Read(ref key) is not null;

    public async Task SetUp(string actor, CancellationToken ct)
    {
        if (Enabled)
            return;
        try
        {
            await database.Write(async (connection, tx) =>
            {
                if (Enabled)
                    return false;
                if (ReadStoredKey() is { } stored)
                {
                    Volatile.Write(ref key, stored);
                    return false;
                }
                if (await connection.ExecuteScalarAsync<bool>(new CommandDefinition(
                    "SELECT EXISTS(SELECT 1 FROM NotificationChannels)", transaction: tx, cancellationToken: ct)))
                    throw Fault.Conflict("notification_key_restore_required");

                await NotificationStorage.Audit(connection, tx, actor, null, "notification.encryption_configured",
                    new { source = "generated" }, ct);
                ct.ThrowIfCancellationRequested();
                Volatile.Write(ref key, CreateStoredKey());
                return true;
            });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw Fault.Unavailable("notification_key_storage_unavailable");
        }
    }

    private byte[]? ReadStoredKey()
    {
        try
        {
            using var file = File.OpenRead(keyPath);
            if (file.Length != KeyLength)
                throw new IOException("The stored notification credential key has an invalid length");
            var value = new byte[KeyLength];
            file.ReadExactly(value);
            return value;
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }

    private byte[] CreateStoredKey()
    {
        var temporary = keyPath + "." + Secrets.Id() + ".tmp";
        var value = RandomNumberGenerator.GetBytes(KeyLength);
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var file = new FileStream(temporary, options))
            {
                file.Write(value);
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, keyPath);
            return value;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(value);
            throw;
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private byte[] RequireKey() =>
        Volatile.Read(ref key) ?? throw Fault.Unavailable("notification_vault_unconfigured");

    public string Seal(string id, string kind, string credential)
    {
        var encryptionKey = RequireKey();

        var envelope = new byte[HeaderLength + credential.Length];
        Span<byte> plain = stackalloc byte[credential.Length];
        Encoding.ASCII.GetBytes(credential, plain);
        try
        {
            RandomNumberGenerator.Fill(envelope.AsSpan(0, NonceLength));
            using var cipher = new AesGcm(encryptionKey, TagLength);
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
        var encryptionKey = RequireKey();

        Span<byte> plain = stackalloc byte[160];
        try
        {
            Span<byte> envelope = stackalloc byte[HeaderLength + 160];
            if (!Convert.TryFromBase64String(channel.SecretCipher, envelope, out var count) || count <= HeaderLength)
                throw Fault.Conflict("notification_credential_unavailable");
            var plaintext = plain[..(count - HeaderLength)];
            using var cipher = new AesGcm(encryptionKey, TagLength);
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

    private static byte[]? ReadConfiguredKey(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return null;
        if (text.Length != KeyLength * 2 || !text.All(char.IsAsciiHexDigit))
            throw new InvalidOperationException("FileSharing:Notifications:CredentialKey must contain 64 hexadecimal characters.");
        return Convert.FromHexString(text);
    }
}
