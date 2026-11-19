using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading.RateLimiting;

namespace FileSharing;

internal sealed class FtpGateway(FtpSettings options, FtpAccounts accounts, FtpFiles files, GatewaySessions sessions, ILogger<FtpGateway> logger)
    : BackgroundService
{
    private readonly List<(TcpListener Listener, string Mode)> listeners = [];
    private readonly ConcurrentDictionary<long, Task> connections = new();
    private readonly SemaphoreSlim slots = new(64);
    private readonly PartitionedRateLimiter<IPAddress> attempts = PartitionedRateLimiter.Create<IPAddress, IPAddress>(
        ip => RateLimitPartition.GetFixedWindowLimiter(ip, _ => new FixedWindowRateLimiterOptions
        {
            Window = TimeSpan.FromMinutes(1), PermitLimit = 18, QueueLimit = 0
        }));
    private long sequence;
    private X509Certificate2? certificate;
    private SslStreamCertificateContext? certificateContext;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (options.ExplicitPort != 0 || options.ImplicitPort != 0)
            {
                var chain = new X509Certificate2Collection();
                if (options.CertificateKey is { Length: > 0 } key)
                {
                    certificate = X509Certificate2.CreateFromPemFile(options.Certificate!, key);
                    chain.ImportFromPemFile(options.Certificate!);
                }
                else
                {
                    chain = X509CertificateLoader.LoadPkcs12CollectionFromFile(options.Certificate!, options.CertificatePassword,
                        X509KeyStorageFlags.EphemeralKeySet);
                    certificate = chain.OfType<X509Certificate2>().FirstOrDefault(item => item.HasPrivateKey);
                }
                if (certificate is null || !certificate.HasPrivateKey || certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow)
                    throw new InvalidOperationException("An unexpired FTP certificate with private key is required.");
                var intermediates = new X509Certificate2Collection(chain.OfType<X509Certificate2>()
                    .Where(item => item.Thumbprint != certificate.Thumbprint).ToArray());
                certificateContext = SslStreamCertificateContext.Create(certificate, intermediates, offline: true);
            }

            Start(options.PlainPort, "plain");
            Start(options.ExplicitPort, "explicitTls");
            Start(options.ImplicitPort, "implicitTls");
            await base.StartAsync(cancellationToken);
        }
        catch
        {
            foreach (var listener in listeners)
                listener.Listener.Stop();
            certificate?.Dispose();
            throw;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.WhenAll(listeners.Select(item => Accept(item.Listener, item.Mode, stoppingToken)));
        await Task.WhenAll(connections.Values);
    }

    private void Start(int port, string mode)
    {
        if (port == 0)
            return;
        var listener = new TcpListener(options.Bind, port);
        listener.Start(64);
        listeners.Add((listener, mode));
        logger.LogInformation("FTP listener {Mode} started on port {Port}", mode, port);
    }

    private async Task Accept(TcpListener listener, string mode, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(ct);
                var peer = Peer(client);
                if ((mode == "plain" && !options.AllowsPlain(peer)) || !slots.Wait(0))
                {
                    client.Dispose();
                    continue;
                }

                var id = Interlocked.Increment(ref sequence);
                var session = Run(client, mode, peer, ct);
                connections.TryAdd(id, session);
                _ = session.ContinueWith(_ =>
                {
                    connections.TryRemove(id, out Task? ignored);
                    slots.Release();
                }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        finally
        {
            listener.Stop();
        }
    }

    private async Task Run(TcpClient socket, string mode, IPAddress ip, CancellationToken ct)
    {
        using (socket)
        {
            try
            {
                socket.NoDelay = true;
                await new FtpSession(this, options, accounts, files, sessions, socket, mode, ip).Run(ct);
            }
            catch (Exception error) when (error is OperationCanceledException or IOException or AuthenticationException or SocketException)
            {
                logger.LogDebug("FTP connection ended with {Kind}", error.GetType().Name);
            }
            catch (Exception error)
            {
                logger.LogError(error, "FTP connection failed");
            }
        }
    }

    internal bool PermitLogin(IPAddress ip)
    {
        using var lease = attempts.AttemptAcquire(ip);
        return lease.IsAcquired;
    }

    internal TcpListener OpenPassive()
    {
        var count = options.PassiveMax - options.PassiveMin + 1;
        var start = RandomNumberGenerator.GetInt32(count);
        for (var index = 0; index < count; index++)
        {
            var listener = new TcpListener(options.Bind, options.PassiveMin + (start + index) % count);
            try
            {
                listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                listener.Start(2);
                return listener;
            }
            catch (SocketException error) when (error.SocketErrorCode == SocketError.AddressAlreadyInUse)
            {
                listener.Stop();
            }
        }
        throw Fault.Unavailable("passive_ports_exhausted");
    }

    internal async Task<SslStream> Secure(Stream transport, CancellationToken ct)
    {
        var secure = new SslStream(transport, leaveInnerStreamOpen: true);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(12));
            await secure.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
            {
                ServerCertificateContext = certificateContext,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                AllowRenegotiation = false
            }, timeout.Token);
            return secure;
        }
        catch
        {
            await secure.DisposeAsync();
            throw;
        }
    }

    internal static IPAddress Peer(TcpClient socket)
    {
        var address = ((IPEndPoint)socket.Client.RemoteEndPoint!).Address;
        return address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
    }

    public override void Dispose()
    {
        base.Dispose();
        certificate?.Dispose();
        attempts.Dispose();
    }
}
