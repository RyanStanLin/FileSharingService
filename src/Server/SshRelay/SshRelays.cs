using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http.Features;

namespace FileSharing;

internal sealed class SshRelays(IConfiguration config, SftpRuntime gateway, ReviewService reviews, DeviceService devices,
    AgentBroker broker, Database db, IHostApplicationLifetime host)
{
    private static readonly TimeSpan InitialLease = TimeSpan.FromMinutes(2);
    private const string UserPrefix = "relay-";
    private readonly Dictionary<string, SshRelay> relays = new();
    private readonly bool enabled = config.GetValue<bool>("FileSharing:SshRelay:Enabled");

    public async Task<SshRelayView> Create(string device, Review review, string? publicKey, CancellationToken ct)
    {
        if (!enabled || gateway.Endpoint() is not { Available: true, HostKeyFingerprint: { } hostKey } endpoint)
            throw Fault.Unavailable("ssh_relay_unavailable");
        var fingerprint = Fingerprint(publicKey);
        await devices.Require(device, ct);
        var link = broker.AccessibleLink(device);
        var generation = broker.AccessGeneration(link) ?? throw Fault.Forbidden("agent_connection_access_required");
        var id = Secrets.Id();
        var view = new SshRelayView(id, endpoint.Host, endpoint.Port, UserPrefix + id, device + ".filesharing.invalid",
            hostKey, DateTimeOffset.UtcNow + InitialLease);
        var relay = new SshRelay(view, review, link, generation, fingerprint);
        lock (relays)
        {
            foreach (var expired in relays.Values.Where(item => !item.Available).ToArray())
                relays.Remove(expired.View.Id);
            if (relays.Count >= 64 || relays.Values.Count(item => item.Link.Device == device) >= 2)
                throw new Fault(429, "ssh_relay_limit");
            relays.Add(id, relay);
        }
        try
        {
            await db.Audit("ssh_relay.created", review.Initiator, device, new { id, connectionId = link.Id }, ct);
            return view;
        }
        catch
        {
            Remove(relay);
            throw;
        }
    }

    public async Task<SshRelayView> AuthorizeJump(string? user, string? fingerprint, CancellationToken ct)
    {
        if (user is not { Length: 42 } || !user.StartsWith(UserPrefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(user.AsSpan(UserPrefix.Length), "D", out var id))
            throw Fault.Unauthorized();
        var relay = Find(id.ToString("D"));
        if (!relay.Pending || !relay.Matches(fingerprint))
            throw Fault.Unauthorized();
        await Check(relay, ct);
        return relay.View;
    }

    public void Delete(string device, string id, Review review)
    {
        var relay = Find(id);
        if (relay.Link.Device != device || relay.ReviewId != review.Id)
            throw Fault.Missing();
        Remove(relay);
    }

    public SshRelay ForAgent(string id, HttpContext context)
    {
        var relay = Find(id);
        var key = context.Request.Headers[AgentBroker.ChannelHeader];
        if (key.Count != 1 || !relay.AgentMatches(key[0]))
            throw Fault.Missing();
        if (broker.AccessGeneration(relay.Link) != relay.Generation)
            throw Fault.Forbidden("agent_connection_access_required");
        return relay;
    }

    public async Task Bridge(string id, HttpContext context)
    {
        var upgrade = context.Features.Get<IHttpUpgradeFeature>();
        if (upgrade is not { IsUpgradableRequest: true } ||
            !string.Equals(context.Request.Headers.Upgrade, "filesharing-ssh", StringComparison.OrdinalIgnoreCase))
            throw Fault.Bad("ssh_upgrade_required");
        var relay = Find(id);
        await Check(relay, context.RequestAborted);
        relay.Attach();

        using var life = CancellationTokenSource.CreateLinkedTokenSource(relay.Stop, relay.Link.Lifetime,
            context.RequestAborted, host.ApplicationStopping);
        var ct = life.Token;
        var agent = broker.Invoke(relay.Link.Device, "ssh.relay", new { channel = relay.AgentToken }, ct,
            relay.View.Id, TimeSpan.FromHours(8), relay.Link.Id, (frame, _) =>
            {
                if (frame.TryGetProperty("kind", out var kind) && kind.ValueKind == System.Text.Json.JsonValueKind.String &&
                    kind.GetString() == "ready")
                    relay.Confirm();
                return Task.CompletedTask;
            });
        try
        {
            var started = await Task.WhenAny(relay.Ready, agent).WaitAsync(TimeSpan.FromSeconds(12), ct);
            if (started == agent)
            {
                await agent;
                throw Fault.Unavailable("ssh_remote_login_unavailable");
            }
            context.Response.Headers.Upgrade = "filesharing-ssh";
            await using var stream = await upgrade.UpgradeAsync();
            await Run(relay, stream, agent, life);
        }
        catch (TimeoutException)
        {
            if (!context.Response.HasStarted)
                throw Fault.Unavailable("ssh_remote_login_unavailable");
        }
        catch (Exception error) when (context.Response.HasStarted &&
            error is Fault or OperationCanceledException or IOException)
        {
            context.Abort();
        }
        finally
        {
            broker.CancelCommand(relay.Link.Device, relay.Link.Id, relay.View.Id);
            Remove(relay);
            await Observe(agent);
        }
    }

    private async Task Run(SshRelay relay, Stream stream, Task agent, CancellationTokenSource life)
    {
        var ct = life.Token;
        var input = relay.ReadGateway(stream, ct);
        var output = relay.WriteGateway(stream, ct);
        var authorization = Monitor(relay, ct);
        try
        {
            var completed = await Task.WhenAny(input, output, authorization, agent);
            await completed;
            if (completed == agent)
                await output.WaitAsync(TimeSpan.FromSeconds(5), ct);
        }
        finally
        {
            await life.CancelAsync();
            await Observe(Task.WhenAll(input, output, authorization));
        }
    }

    private SshRelay Find(string id)
    {
        lock (relays)
            return relays.TryGetValue(Secrets.Identifier(id), out var relay) && relay.Available
                ? relay : throw Fault.Missing("ssh_relay_not_found");
    }

    private void Remove(SshRelay relay)
    {
        lock (relays)
            relays.Remove(relay.View.Id);
        relay.Close();
    }

    private async Task Check(SshRelay relay, CancellationToken ct)
    {
        if (await reviews.ActiveById(relay.ReviewId, ct) is null)
            throw Fault.Unauthorized();
        if (broker.AccessGeneration(relay.Link) != relay.Generation)
            throw Fault.Forbidden("agent_connection_access_required");
    }

    private async Task Monitor(SshRelay relay, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(ct))
            await Check(relay, ct);
    }

    private static async Task Observe(Task task)
    {
        try { await task; }
        catch (Exception error) when (error is Fault or OperationCanceledException or IOException) { }
    }

    private static string Fingerprint(string? value)
    {
        if (value is not { Length: > 0 and <= 8192 })
            throw Fault.Bad("invalid_ssh_public_key");
        var line = value.Trim();
        var parts = line.Split([' ', '\t'], 3, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || line.Contains('\r') || line.Contains('\n') ||
            parts[0] is not ("ssh-ed25519" or "ssh-rsa" or "ecdsa-sha2-nistp256" or "ecdsa-sha2-nistp384" or "ecdsa-sha2-nistp521"
                or "sk-ssh-ed25519@openssh.com" or "sk-ecdsa-sha2-nistp256@openssh.com"))
            throw Fault.Bad("invalid_ssh_public_key");
        Span<byte> bytes = stackalloc byte[4096];
        if (!Convert.TryFromBase64String(parts[1], bytes, out var count) || count < parts[0].Length + 8 ||
            BinaryPrimitives.ReadUInt32BigEndian(bytes) != parts[0].Length ||
            !bytes.Slice(4, parts[0].Length).SequenceEqual(Encoding.ASCII.GetBytes(parts[0])))
            throw Fault.Bad("invalid_ssh_public_key");
        return "SHA256:" + Convert.ToBase64String(SHA256.HashData(bytes[..count])).TrimEnd('=');
    }
}
