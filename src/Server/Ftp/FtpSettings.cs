using System.Net;

namespace FileSharing;

internal sealed record FtpEndpoint(string Mode, string Host, int Port, string Scheme)
{
    public string Address => new UriBuilder(Scheme, Host, Port, "/").Uri.AbsoluteUri;
}

internal sealed record FtpSettings(
    IPAddress Bind, string Host, int PlainPort, int ExplicitPort, int ImplicitPort,
    int PassiveMin, int PassiveMax, IPAddress? PassiveAddress, IPNetwork[] PlainClients,
    string? Certificate, string? CertificateKey, string? CertificatePassword)
{
    public static FtpSettings Read(IConfiguration config, Settings settings)
    {
        var section = config.GetSection("FileSharing:Ftp");
        var bind = IPAddress.Parse(section["Bind"] ?? "127.0.0.1");
        var plain = Port("PlainPort", 0);
        var explicitPort = Port("ExplicitPort", 0);
        var implicitPort = Port("ImplicitPort", 0);
        var min = Port("PassiveMin", 41000);
        var max = Port("PassiveMax", 41031);
        var address = section["PassiveAddress"] is { Length: > 0 } value ? IPAddress.Parse(value) : null;
        var host = section["Host"] ?? settings.Origin.IdnHost;
        var networks = (section["PlainClients"] ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(IPNetwork.Parse).ToArray();
        if (plain != 0 && !IPAddress.IsLoopback(bind) && networks.Length == 0)
            throw new InvalidOperationException("Plain FTP requires an explicit client CIDR allowlist.");
        var ports = new[] { plain, explicitPort, implicitPort }.Where(port => port != 0).ToArray();
        if (min == 0 || max < min || max - min > 999 || ports.Distinct().Count() != ports.Length ||
            ports.Any(port => port >= min && port <= max) ||
            address is { AddressFamily: not System.Net.Sockets.AddressFamily.InterNetwork } ||
            Uri.CheckHostName(host) is UriHostNameType.Unknown)
            throw new InvalidOperationException("Invalid FTP port, passive address or public hostname.");
        var certificate = section["Certificate"];
        if ((explicitPort != 0 || implicitPort != 0) && string.IsNullOrWhiteSpace(certificate))
            throw new InvalidOperationException("FTPS requires a server certificate.");
        return new(bind, host, plain, explicitPort, implicitPort, min, max, address, networks,
            certificate, section["CertificateKey"], section["CertificatePassword"]);

        int Port(string key, int fallback)
        {
            var result = section.GetValue(key, fallback);
            return result is >= 0 and <= 65535 ? result : throw new InvalidOperationException($"Invalid FTP {key}.");
        }
    }

    public FtpEndpoint[] Endpoints()
    {
        var endpoints = new List<FtpEndpoint>(3);
        if (ExplicitPort > 0)
            endpoints.Add(new("explicitTls", Host, ExplicitPort, "ftp"));
        if (ImplicitPort > 0)
            endpoints.Add(new("implicitTls", Host, ImplicitPort, "ftps"));
        if (PlainPort > 0)
            endpoints.Add(new("plain", Host, PlainPort, "ftp"));
        return [.. endpoints];
    }

    public bool AllowsPlain(IPAddress ip) => PlainClients.Length == 0
        ? IPAddress.IsLoopback(ip)
        : PlainClients.Any(network => network.Contains(ip));
}
