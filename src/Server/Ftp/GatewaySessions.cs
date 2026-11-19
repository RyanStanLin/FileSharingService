using System.Collections.Concurrent;
using System.Net;

namespace FileSharing;

/// <summary>Current file gateway connection and its last authenticated activity.</summary>
internal sealed record GatewayConnection(string Id, string AccountId, string Protocol, string PeerAddress,
    DateTimeOffset ConnectedAt, DateTimeOffset LastActivityAt);

internal sealed class GatewaySessions(FtpAccounts accounts)
{
    internal sealed class Session(FtpIdentity identity, string protocol, string peer)
    {
        public string Token { get; } = Secrets.New();
        public string Id { get; } = Secrets.Id();
        public FtpIdentity Identity { get; } = identity;
        public string Protocol { get; } = protocol;
        private readonly long connected = Clock.Now;
        private long lastActivity = Clock.Now;

        public void Touch() => Interlocked.Exchange(ref lastActivity, Clock.Now);
        public GatewayConnection View() => new(Id, Identity.Id, Protocol, peer, Clock.At(connected), Clock.At(Interlocked.Read(ref lastActivity)));
    }

    private readonly ConcurrentDictionary<string, Session> sessions = new();

    public Session Start(FtpIdentity identity, string protocol, IPAddress peer)
    {
        var session = new Session(identity, protocol, peer.ToString());
        sessions[session.Token] = session;
        return session;
    }

    public void End(Session? session)
    {
        if (session is not null)
            sessions.TryRemove(new KeyValuePair<string, Session>(session.Token, session));
    }

    public async Task<FtpIdentity> RequireSftp(string? token, CancellationToken ct)
    {
        if (LookupSftp(token) is not { } session)
            throw Fault.Unauthorized();
        if (!await accounts.Active(session.Identity, ct))
        {
            End(session);
            throw Fault.Unauthorized();
        }
        session.Touch();
        return session.Identity;
    }

    public void EndSftp(string? token) => End(LookupSftp(token));

    public void Clear(string protocol)
    {
        foreach (var item in sessions.Values)
            if (item.Protocol == protocol)
                End(item);
    }

    private Session? LookupSftp(string? token) => token is { Length: 43 } &&
        sessions.TryGetValue(token, out var candidate) && candidate.Protocol == "sftp" ? candidate : null;

    public async Task<IReadOnlyList<GatewayConnection>> List(string? account, string owner, CancellationToken ct)
    {
        if (account is not null)
            await accounts.Get(account, owner, ct);
        var owned = await accounts.OwnedIds(owner, ct);
        var active = new List<GatewayConnection>();
        foreach (var session in sessions.Values.OrderBy(x => x.Id))
        {
            if (owned.Contains(session.Identity.Id) && (account is null || session.Identity.Id == account) &&
                await accounts.Active(session.Identity, ct))
                active.Add(session.View());
        }
        return active;
    }
}
