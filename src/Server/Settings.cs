using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

namespace FileSharing;

internal sealed class Settings
{
    public required Uri Origin { get; init; }
    public required string DataDirectory { get; init; }
    public required IPAddress[] Proxies { get; init; }
    public required byte[] BootstrapHash { get; init; }
    public required bool LoopbackDevelopment { get; init; }
    public required int MaxDevices { get; init; }

    public static Settings Read(IConfiguration config, IHostEnvironment environment)
    {
        var origin = new Uri(config["FileSharing:Origin"] ?? "https://filesharing.test");
        var loopback = environment.IsDevelopment() && origin.IsLoopback;
        if ((origin.Scheme != "https" && !loopback) || origin.AbsolutePath != "/" ||
            origin.UserInfo.Length > 0 || origin.Query.Length > 0 || origin.Fragment.Length > 0)
            throw new InvalidOperationException("FileSharing:Origin must be an HTTPS origin.");
        var bootstrap = config["FileSharing:BootstrapSecret"];
        if (bootstrap is not { Length: >= 43 and <= 200 })
            throw new InvalidOperationException("FileSharing:BootstrapSecret must contain at least 43 random characters.");
        var maxDevices = config.GetValue("FileSharing:MaxDevices", 100);
        if (maxDevices is < 1 or > 10000)
            throw new InvalidOperationException("FileSharing:MaxDevices must be between 1 and 10000.");
        return new Settings
        {
            Origin = origin,
            LoopbackDevelopment = loopback,
            MaxDevices = maxDevices,
            DataDirectory = Path.GetFullPath(config["FileSharing:DataDirectory"] ?? ".local/data"),
            Proxies = (config["FileSharing:KnownProxies"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(IPAddress.Parse).ToArray(),
            BootstrapHash = Secrets.HashBytes(bootstrap)
        };
    }

    public string OriginValue => Origin.GetLeftPart(UriPartial.Authority);
    public string Cookie => LoopbackDevelopment && Origin.Scheme == "http" ? "fs-admin-dev" : "__Host-fs-admin";
}

internal static class Secrets
{
    public static string New(int bytes = 32) => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(bytes));
    public static byte[] HashBytes(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
    public static string Hash(string value) => Convert.ToHexString(HashBytes(value));
    public static string Id() => Guid.NewGuid().ToString("D");

    public static string Text(string? value, int maximum = 120)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Length > maximum || trimmed.Any(char.IsControl))
            throw Fault.Bad("invalid_text");
        return trimmed;
    }

    public static string Identifier(string? value)
    {
        if (!Guid.TryParseExact(value, "D", out var parsed) || parsed.ToString("D") != value)
            throw Fault.Bad("invalid_id");
        return value;
    }
}
