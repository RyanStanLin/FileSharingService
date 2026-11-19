using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace FileSharing;

internal sealed record SftpSettings(IPEndPoint Bind, string Host, int BridgePort, string Binary, string HostKey)
{
    public bool Enabled => Bind.Port != 0;

    public static SftpSettings Read(IConfiguration config, Settings settings, FtpSettings ftp)
    {
        var section = config.GetSection("FileSharing:Sftp");
        var port = section.GetValue("Port", 0);
        var bridgePort = section.GetValue("BridgePort", 8080);
        if (port is < 0 or > 65535 || bridgePort is < 1 or > 65535 ||
            port != 0 && (port == bridgePort || port == ftp.PlainPort || port == ftp.ExplicitPort || port == ftp.ImplicitPort ||
                          port >= ftp.PassiveMin && port <= ftp.PassiveMax))
            throw new InvalidOperationException("Invalid SFTP port or port conflict.");
        var binary = Path.GetFullPath(section["Binary"] ?? Path.Combine(AppContext.BaseDirectory, "filesharing-sftp"));
        if (port != 0 && !File.Exists(binary))
            throw new InvalidOperationException("The configured SFTP worker binary is missing.");
        return new(new IPEndPoint(ftp.Bind, port), ftp.Host, bridgePort, binary, Path.Combine(settings.DataDirectory, "sftp-host-key"));
    }
}

internal sealed class SftpRuntime(SftpSettings settings)
{
    private readonly string key = Secrets.New();
    private string? fingerprint;

    public string Key => key;
    public bool Ready => !settings.Enabled || Volatile.Read(ref fingerprint) is not null;

    public void Online(string? value) => Volatile.Write(ref fingerprint, value);

    public FtpEndpoint? Endpoint()
    {
        var current = Volatile.Read(ref fingerprint);
        return settings.Enabled ? new("sftp", settings.Host, settings.Bind.Port, "sftp", current, current is not null) : null;
    }

    public bool Allows(HttpContext context)
    {
        if (!settings.Enabled || context.Connection.RemoteIpAddress is not { } address ||
            !IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address))
            return false;
        var authorization = context.Request.Headers.Authorization;
        return authorization.Count == 1 && authorization[0] is { Length: 50 } supplied &&
            supplied.StartsWith("Bearer ", StringComparison.Ordinal) &&
            CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied[7..]), Encoding.UTF8.GetBytes(key));
    }
}

internal sealed class SftpGateway(SftpSettings settings, SftpRuntime runtime, GatewaySessions sessions,
    IHostApplicationLifetime lifetime, ILogger<SftpGateway> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        if (!settings.Enabled)
            return;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        await started.Task.WaitAsync(ct);
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Run(ct);
                if (!ct.IsCancellationRequested)
                    logger.LogWarning("SFTP worker exited and will restart.");
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                logger.LogError(error, "SFTP worker could not run.");
            }
            finally
            {
                runtime.Online(null);
                sessions.Clear("sftp");
            }
            if (!ct.IsCancellationRequested)
                await Task.Delay(TimeSpan.FromSeconds(3), ct);
        }
    }

    private async Task Run(CancellationToken ct)
    {
        var start = new ProcessStartInfo(settings.Binary) { UseShellExecute = false, RedirectStandardInput = true };
        start.Environment.Clear();
        start.Environment["FILESHARING_SFTP_BRIDGE"] = $"http://127.0.0.1:{settings.BridgePort}";
        start.Environment["FILESHARING_SFTP_TOKEN"] = runtime.Key;
        start.Environment["FILESHARING_SFTP_KEY"] = settings.HostKey;
        start.Environment["FILESHARING_SFTP_LISTEN"] = settings.Bind.ToString();
        using var process = Process.Start(start) ?? throw new InvalidOperationException("SFTP worker failed to start.");
        try
        {
            await process.WaitForExitAsync(ct);
        }
        finally
        {
            process.StandardInput.Close();
            using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try
            {
                await process.WaitForExitAsync(stop.Token);
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited)
                    process.Kill();
                await process.WaitForExitAsync(CancellationToken.None);
            }
        }
    }
}
