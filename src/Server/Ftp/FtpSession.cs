using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;

namespace FileSharing;

internal sealed class FtpSession(FtpGateway gateway, FtpSettings options, FtpAccounts accounts, FtpFiles files,
    GatewaySessions sessions, TcpClient socket, string mode, IPAddress peer)
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private readonly SemaphoreSlim replies = new(1);
    private Stream control = socket.GetStream();
    private SslStream? secureControl;
    private TcpListener? passive;
    private IPEndPoint? activeEndpoint;
    private string? username;
    private FtpIdentity? identity;
    private GatewaySessions.Session? session;
    private string directory = "/";
    private bool protectedData;
    private bool negotiated;
    private bool epsvOnly;
    private bool binary;
    private long restart;
    private CancellationTokenSource? transferStop;
    private Task? transfer;
    private volatile bool transferFinalizing;

    public async Task Run(CancellationToken ct)
    {
        try
        {
            if (mode == "implicitTls")
            {
                await Upgrade(ct);
                protectedData = true;
            }

            await Reply("220 FileSharing ready", ct);
            while (!ct.IsCancellationRequested)
            {
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                idle.CancelAfter(transfer is { IsCompleted: false } ? TimeSpan.FromHours(2) : TimeSpan.FromMinutes(2));
                var line = await Read(idle.Token);
                if (line is null)
                    return;
                session?.Touch();
                var separator = line.IndexOf(' ');
                var verb = (separator < 0 ? line : line[..separator]).ToUpperInvariant();
                var argument = separator < 0 ? "" : line[(separator + 1)..];
                if (!await Dispatch(verb, argument, ct))
                    return;
            }
        }
        finally
        {
            sessions.End(session);
            if (transferStop is not null)
                await transferStop.CancelAsync();
            if (transfer is not null)
                await transfer;
            transferStop?.Dispose();
            ClearDataChannel();
            if (secureControl is not null)
                await secureControl.DisposeAsync();
            replies.Dispose();
        }
    }

    private async Task<bool> Dispatch(string verb, string argument, CancellationToken ct)
    {
        if (transfer is { IsCompleted: false } finishing && transferFinalizing)
            await finishing;

        if (transfer is { IsCompleted: false })
        {
            switch (verb)
            {
                case "ABOR":
                    await transferStop!.CancelAsync();
                    await transfer;
                    await Reply("226 Abort acknowledged", ct);
                    return true;
                case "NOOP":
                    await Reply("200 OK", ct);
                    return true;
                case "QUIT":
                    await transferStop!.CancelAsync();
                    await transfer;
                    await Reply("221 Goodbye", ct);
                    return false;
                default:
                    await Reply("450 Transfer in progress", ct);
                    return true;
            }
        }

        try
        {
            switch (verb)
            {
                case "QUIT": await Reply("221 Goodbye", ct); return false;
                case "FEAT":
                    var tls = mode == "plain" ? "" : " AUTH TLS\r\n PBSZ\r\n PROT\r\n";
                    var active = AllowsActiveData ? " EPRT\r\n" : "";
                    await Reply("211-Features\r\n" + tls + active +
                        " UTF8\r\n EPSV\r\n PASV\r\n MDTM\r\n SIZE\r\n REST STREAM\r\n MLST Type*;Size*;Modify*;\r\n211 End", ct);
                    return true;
                case "SYST": await Reply("215 UNIX Type: L8", ct); return true;
                case "NOOP": await Reply("200 OK", ct); return true;
                case "OPTS":
                    await Reply(argument.Equals("UTF8 ON", StringComparison.OrdinalIgnoreCase) || argument.StartsWith("MLST ", StringComparison.OrdinalIgnoreCase)
                        ? "200 Options accepted" : "501 Unsupported option", ct);
                    return true;
                case "AUTH":
                    if (mode != "explicitTls" || secureControl is not null || identity is not null ||
                        !argument.Equals("TLS", StringComparison.OrdinalIgnoreCase))
                        await Reply("534 TLS upgrade unavailable", ct);
                    else
                    {
                        await Reply("234 Starting TLS", ct);
                        username = null;
                        await Upgrade(ct);
                    }
                    return true;
                case "PBSZ":
                    negotiated = secureControl is not null && argument == "0";
                    await Reply(negotiated ? "200 PBSZ=0" : "503 TLS and PBSZ 0 required", ct);
                    return true;
                case "PROT":
                    if (negotiated && argument == "P")
                    {
                        protectedData = true;
                        await Reply("200 Data protection private", ct);
                    }
                    else
                        await Reply("534 Private data protection required", ct);
                    return true;
                case "USER":
                    sessions.End(session);
                    session = null;
                    identity = null;
                    username = null;
                    directory = "/";
                    restart = 0;
                    ClearDataChannel();
                    if (mode != "plain" && secureControl is null)
                        await Reply("534 TLS required for login", ct);
                    else
                    {
                        username = argument;
                        await Reply("331 Password required", ct);
                    }
                    return true;
                case "PASS":
                    if (username is null)
                        await Reply("503 Send USER first", ct);
                    else
                    {
                        var (authenticated, rateLimited) = await gateway.Login(username, argument, mode == "plain" ? "ftp" : "ftps", peer, ct);
                        if (rateLimited)
                        {
                            await Reply("421 Too many login attempts", ct);
                            return false;
                        }
                        identity = authenticated;
                        if (identity is not null)
                            session = sessions.Start(identity, mode == "plain" ? "ftp" : "ftps", peer);
                        username = null;
                        await Reply(identity is not null ? "230 Logged in" : "530 Login failed", ct);
                    }
                    return true;
            }

            if (identity is null || !await accounts.Active(identity, ct))
            {
                sessions.End(session);
                session = null;
                identity = null;
                ClearDataChannel();
                await Reply("530 Login required", ct);
                return true;
            }

            switch (verb)
            {
                case "PWD":
                case "XPWD":
                    await Reply($"257 \"{directory.Replace("\"", "\"\"")}\"", ct);
                    break;
                case "TYPE" when argument is "I" or "A" or "L 8":
                    binary = argument != "A";
                    restart = 0;
                    await Reply("200 Type set", ct);
                    break;
                case "MODE" when argument == "S":
                case "STRU" when argument == "F":
                    await Reply("200 OK", ct);
                    break;
                case "ABOR":
                    ClearDataChannel();
                    restart = 0;
                    await Reply("225 No transfer in progress", ct);
                    break;
                case "CWD":
                case "CDUP":
                    var destination = Resolve(verb == "CDUP" ? ".." : argument);
                    if ((await files.Stat(identity, destination, ct)).Kind != "directory")
                        throw Fault.Missing();
                    directory = destination;
                    await Reply("250 Directory changed", ct);
                    break;
                case "PASV":
                case "EPSV":
                case "PORT":
                case "EPRT":
                    await SelectDataChannel(verb, argument, ct);
                    break;
                case "REST":
                    if (!binary || !long.TryParse(argument, NumberStyles.None, CultureInfo.InvariantCulture, out restart))
                    {
                        restart = 0;
                        await Reply("501 A binary stream byte offset is required", ct);
                    }
                    else
                        await Reply("350 Restart position accepted", ct);
                    break;
                case "MDTM":
                case "SIZE":
                case "MLST":
                    var path = Resolve(argument);
                    var entry = await files.Stat(identity, path, ct);
                    if (verb is "SIZE" or "MDTM" && entry.Kind != "file")
                        throw Fault.Missing();
                    if (verb == "SIZE" && !binary)
                        await Reply("550 Binary transfer type required", ct);
                    else
                        await Reply(verb switch
                        {
                            "SIZE" => $"213 {entry.Size}",
                            "MDTM" => $"213 {Timestamp(entry)}",
                            _ => $"250-Listing\r\n {Facts(entry)} {path}\r\n250 End"
                        }, ct);
                    break;
                case "RETR":
                case "MLSD":
                case "LIST":
                case "NLST":
                    var dataPath = Resolve(ListArgument(verb, argument));
                    await StartTransfer(identity, verb, dataPath, ct);
                    break;
                default:
                    await Reply("502 Command not implemented", ct);
                    break;
            }
        }
        catch (Fault fault)
        {
            await Reply(ResourceFailure(fault), ct);
        }
        return true;
    }

    private IPAddress LocalAddress
    {
        get
        {
            var address = ((IPEndPoint)socket.Client.LocalEndPoint!).Address;
            return address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
        }
    }

    private bool AllowsActiveData => IPAddress.IsLoopback(options.Bind) && IPAddress.IsLoopback(peer);
    private string NetworkProtocol => LocalAddress.AddressFamily == AddressFamily.InterNetworkV6 ? "2" : "1";

    private void ClearDataChannel()
    {
        passive?.Stop();
        passive = null;
        activeEndpoint = null;
    }

    private async Task SelectDataChannel(string verb, string argument, CancellationToken ct)
    {
        ClearDataChannel();
        if (mode != "plain" && !protectedData)
        {
            await Reply("534 PROT P required", ct);
            return;
        }
        if (epsvOnly && verb != "EPSV")
        {
            await Reply("501 EPSV ALL is in effect", ct);
            return;
        }
        if (verb is "PASV" or "EPSV")
            await Passive(verb, argument, ct);
        else
            await Active(verb, argument, ct);
    }

    private async Task Passive(string verb, string argument, CancellationToken ct)
    {
        var address = options.PassiveAddress ?? LocalAddress;
        if (verb == "PASV" && address.AddressFamily != AddressFamily.InterNetwork)
        {
            await Reply("522 Use EPSV", ct);
            return;
        }
        if (verb == "EPSV")
        {
            if (argument.Equals("ALL", StringComparison.OrdinalIgnoreCase))
            {
                epsvOnly = true;
                await Reply("200 EPSV ALL accepted", ct);
                return;
            }
            if (argument.Length != 0 && argument != NetworkProtocol)
            {
                await Reply($"522 Use network protocol ({NetworkProtocol})", ct);
                return;
            }
        }
        passive = gateway.OpenPassive();
        var port = ((IPEndPoint)passive.LocalEndpoint).Port;
        await Reply(verb == "EPSV" ? $"229 Entering Extended Passive Mode (|||{port}|)" :
            $"227 Entering Passive Mode ({string.Join(',', address.GetAddressBytes())},{port / 256},{port % 256})", ct);
    }

    private async Task Active(string verb, string argument, CancellationToken ct)
    {
        if (!AllowsActiveData)
        {
            await Reply("504 Active data connections unavailable on this listener. Use PASV or EPSV", ct);
            return;
        }

        IPEndPoint? target;
        if (verb == "PORT")
        {
            if (NetworkProtocol != "1")
            {
                await Reply("522 Use EPRT with network protocol (2)", ct);
                return;
            }
            target = ParsePort(argument);
        }
        else
        {
            var fields = argument.Length > 0 && argument[0] is >= '!' and <= '~' ? argument.Split(argument[0]) : [];
            if (fields is not ["", var protocol, var address, var port, ""] ||
                !int.TryParse(protocol, NumberStyles.None, CultureInfo.InvariantCulture, out _))
            {
                await Reply("501 Invalid EPRT argument", ct);
                return;
            }
            if (protocol != NetworkProtocol)
            {
                await Reply($"522 Use network protocol ({NetworkProtocol})", ct);
                return;
            }
            target = IPAddress.TryParse(address, out var ip) && ip.AddressFamily == LocalAddress.AddressFamily &&
                     ushort.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
                ? new IPEndPoint(ip, number) : null;
        }

        if (target is null || !target.Address.Equals(peer) || target.Port < 1024)
        {
            await Reply("501 Active data requires the control peer address and an unprivileged port", ct);
            return;
        }
        activeEndpoint = target;
        await Reply("200 Active data endpoint accepted", ct);
    }

    private static IPEndPoint? ParsePort(string argument)
    {
        var parts = argument.Split(',');
        Span<byte> values = stackalloc byte[6];
        if (parts.Length != values.Length)
            return null;
        for (var i = 0; i < values.Length; i++)
            if (!byte.TryParse(parts[i], NumberStyles.None, CultureInfo.InvariantCulture, out values[i]))
                return null;
        return new IPEndPoint(new IPAddress(values[..4]), values[4] * 256 + values[5]);
    }

    private async Task StartTransfer(FtpIdentity user, string verb, string path, CancellationToken ct)
    {
        var offset = restart;
        restart = 0;
        var listener = passive;
        var destination = activeEndpoint;
        if (listener is null && destination is null)
        {
            await Reply("425 Negotiate a data connection first", ct);
            return;
        }
        passive = null;
        activeEndpoint = null;
        transferStop?.Dispose();
        transferStop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        transferStop.CancelAfter(TimeSpan.FromHours(2));
        transferFinalizing = false;
        transfer = SendData(user, listener, destination, verb, path, offset, transferStop.Token, ct);
    }

    private async Task SendData(FtpIdentity user, TcpListener? listener, IPEndPoint? destination, string verb, string path, long offset,
        CancellationToken transferToken, CancellationToken controlToken)
    {
        var started = false;
        try
        {
            (FtpPath Path, FileEntry Entry)? file = null;
            if (verb == "RETR")
            {
                if (!binary)
                {
                    await FinalTransferReply("550 Binary transfer type required", controlToken);
                    return;
                }
                file = await files.Prepare(user, path, offset, transferToken);
            }
            else
                await files.Stat(user, path, transferToken);

            await Reply("150 Opening data connection", controlToken);
            started = true;
            using var setup = CancellationTokenSource.CreateLinkedTokenSource(transferToken);
            setup.CancelAfter(TimeSpan.FromSeconds(12));
            using var client = listener is not null ? await AcceptData(listener, setup.Token) : await ConnectData(destination!, setup.Token);
            listener?.Stop();
            var transport = client.GetStream();
            await using var tls = mode == "plain" ? null : await gateway.Secure(transport, setup.Token);
            Stream output = tls is null ? transport : tls;
            if (file is { } source)
                await files.Download(user, source.Path, source.Entry, offset, output, transferToken);
            else
                await foreach (var entry in files.List(user, path, transferToken))
                {
                    var data = verb switch
                    {
                        "NLST" => entry.Name,
                        "MLSD" => $"{Facts(entry)} {entry.Name}",
                        _ => UnixList(entry)
                    };
                    await output.WriteAsync(Utf8.GetBytes(data + "\r\n"), transferToken);
                }
            await output.FlushAsync(transferToken);
            if (tls is not null)
                await tls.ShutdownAsync().WaitAsync(transferToken);
            client.Dispose();
            await FinalTransferReply("226 Transfer complete", controlToken);
        }
        catch (Exception error) when (error is Fault or IOException or OperationCanceledException or SocketException or System.Security.Authentication.AuthenticationException)
        {
            if (controlToken.IsCancellationRequested)
                return;
            var reply = error switch
            {
                Fault { Code: "source_changed" or "invalid_restart_marker" } when !started => "551 Restart rejected",
                Fault fault => ResourceFailure(fault, started),
                _ => started ? "426 Transfer aborted" : "550 Resource unavailable"
            };
            try { await FinalTransferReply(reply, controlToken); }
            catch (Exception disconnected) when (disconnected is IOException or OperationCanceledException or SocketException) { }
        }
        finally
        {
            listener?.Stop();
        }
    }

    private Task FinalTransferReply(string reply, CancellationToken ct)
    {
        transferFinalizing = true;
        return Reply(reply, ct);
    }

    private async Task<TcpClient> AcceptData(TcpListener listener, CancellationToken ct)
    {
        while (true)
        {
            var candidate = await listener.AcceptTcpClientAsync(ct);
            if (FtpGateway.Peer(candidate).Equals(peer))
                return candidate;
            candidate.Dispose();
        }
    }

    private async Task<TcpClient> ConnectData(IPEndPoint endpoint, CancellationToken ct)
    {
        var client = new TcpClient(new IPEndPoint(LocalAddress, 0));
        try
        {
            await client.ConnectAsync(endpoint, ct);
            return client;
        }
        catch
        {
            client.Dispose();
            throw;
        }
    }

    private async Task Upgrade(CancellationToken ct)
    {
        secureControl = await gateway.Secure(control, ct);
        control = secureControl;
    }

    private string Resolve(string argument)
    {
        if (argument.Length == 0)
            return directory;
        var stack = argument.StartsWith('/') ? new List<string>() : directory.Split('/', StringSplitOptions.RemoveEmptyEntries).ToList();
        foreach (var part in argument.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == "..")
            {
                if (stack.Count > 0)
                    stack.RemoveAt(stack.Count - 1);
            }
            else if (part != ".")
                stack.Add(part);
        }
        return "/" + FileService.PathKey(string.Join('/', stack));
    }

    private async Task<string?> Read(CancellationToken ct)
    {
        var length = 0;
        var bytes = new byte[8_193];
        while (length < bytes.Length && await control.ReadAsync(bytes.AsMemory(length, 1), ct) > 0)
        {
            if (bytes[length] == (byte)'\n')
            {
                var line = Utf8.GetString(bytes, 0, length > 0 && bytes[length - 1] == (byte)'\r' ? length - 1 : length);
                return line.Any(char.IsControl) ? throw new IOException("Invalid control line.") : line;
            }
            length++;
        }
        return null;
    }

    private async Task Reply(string response, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        await replies.WaitAsync(timeout.Token);
        try
        {
            await control.WriteAsync(Utf8.GetBytes(response + "\r\n"), timeout.Token);
            await control.FlushAsync(timeout.Token);
        }
        finally
        {
            replies.Release();
        }
    }

    private static string ResourceFailure(Fault fault, bool started = false)
    {
        var code = started ? "426" : "550";
        return fault.Code switch
        {
            "root_identity_changed" => $"{code} Shared directory needs local reapproval",
            "filesystem_access_denied" => $"{code} Filesystem access denied by macOS",
            _ when started => "426 Transfer aborted",
            _ => fault.Status switch
            {
                400 => "501 Invalid argument",
                401 => "530 Login required",
                503 or 504 => "450 Resource temporarily unavailable",
                _ => "550 Resource unavailable"
            }
        };
    }

    private static string ListArgument(string verb, string argument)
    {
        if (verb != "LIST")
            return argument;
        var separator = argument.IndexOf(' ');
        var option = separator < 0 ? argument : argument[..separator];
        return option is "-a" or "-l" or "-la" or "-al" ? argument[(separator < 0 ? argument.Length : separator + 1)..] : argument;
    }
    private static string Timestamp(FileEntry entry) => entry.ModifiedAt.ToUniversalTime().ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
    private static string Facts(FileEntry entry) => $"Type={(entry.Kind == "directory" ? "dir" : "file")};Size={entry.Size};Modify={Timestamp(entry)};";
    private static string UnixList(FileEntry entry)
    {
        var stamp = entry.ModifiedAt.ToUniversalTime().ToString("MMM dd  yyyy", CultureInfo.InvariantCulture);
        var bits = new string("rwxrwxrwx".Select((value, index) => (entry.Mode & (1 << (8 - index))) != 0 ? value : '-').ToArray());
        return $"{(entry.Kind == "directory" ? 'd' : '-')}{bits} 1 {entry.Owner} 0 {entry.Size} {stamp} {entry.Name}";
    }
}
