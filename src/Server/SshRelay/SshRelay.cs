using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace FileSharing;

internal sealed record SshRelayView(string Id, string Host, int Port, string JumpUser, string Destination,
    string HostKeyFingerprint, DateTimeOffset ExpiresAt);
internal sealed record SshRelayChunk(long Index, string? Data);

internal sealed class SshRelay(SshRelayView view, Review review, AgentBroker.Link link, long generation, string fingerprint)
{
    public const int ChunkSize = 16 * 1024;
    private readonly Channel<SshRelayChunk> input = Channel.CreateBounded<SshRelayChunk>(8);
    private readonly Channel<byte[]> output = Channel.CreateBounded<byte[]>(8);
    private readonly SemaphoreSlim readLock = new(1);
    private readonly SemaphoreSlim writeLock = new(1);
    private readonly CancellationTokenSource stopped = new();
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private SshRelayChunk? lastRead;
    private long lastWritten;
    private int attached;

    public SshRelayView View { get; } = view;
    public string ReviewId { get; } = review.Id;
    public AgentBroker.Link Link { get; } = link;
    public long Generation { get; } = generation;
    public string AgentToken { get; } = Secrets.New();
    public CancellationToken Stop => stopped.Token;
    public Task Ready => ready.Task;
    public bool Pending => Volatile.Read(ref attached) == 0;
    public bool Available => !Stop.IsCancellationRequested && (!Pending || View.ExpiresAt > DateTimeOffset.UtcNow);

    public bool Matches(string? value) => Matches(fingerprint, value);

    public bool AgentMatches(string? value) => !Pending && Matches(AgentToken, value);

    public void Attach()
    {
        if (!Available || Interlocked.Exchange(ref attached, 1) != 0)
            throw Fault.Conflict("ssh_relay_used");
    }

    public void Confirm() => ready.TrySetResult();
    public void Close() => stopped.Cancel();

    public async Task<SshRelayChunk?> ReadInput(long after, CancellationToken request)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(Stop, request);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var ct = deadline.Token;
        await readLock.WaitAsync(ct);
        try
        {
            if (lastRead is { } previous && after == previous.Index - 1)
                return previous;
            if (after != (lastRead?.Index ?? 0))
                throw Fault.Conflict("invalid_ssh_cursor");
            if (!await input.Reader.WaitToReadAsync(ct))
                return null;
            lastRead = await input.Reader.ReadAsync(ct);
            return lastRead;
        }
        catch (OperationCanceledException) when (!Stop.IsCancellationRequested && !request.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            readLock.Release();
        }
    }

    public async Task WriteOutput(SshRelayChunk chunk, CancellationToken request)
    {
        if (chunk.Index <= 0 || chunk.Data is { Length: > 21_848 })
            throw Fault.Bad("invalid_ssh_chunk");
        byte[]? bytes = null;
        if (chunk.Data is { } data)
        {
            bytes = new byte[ChunkSize];
            if (!Convert.TryFromBase64String(data, bytes, out var count) || count == 0)
                throw Fault.Bad("invalid_ssh_chunk");
            if (count < bytes.Length)
                Array.Resize(ref bytes, count);
        }
        using var life = CancellationTokenSource.CreateLinkedTokenSource(Stop, request);
        var ct = life.Token;
        await writeLock.WaitAsync(ct);
        try
        {
            if (chunk.Index == lastWritten)
                return;
            if (chunk.Index != lastWritten + 1)
                throw Fault.Conflict("invalid_ssh_cursor");
            if (bytes is null)
                output.Writer.TryComplete();
            else
                await output.Writer.WriteAsync(bytes, ct);
            lastWritten = chunk.Index;
        }
        finally
        {
            writeLock.Release();
        }
    }

    public async Task ReadGateway(Stream stream, CancellationToken ct)
    {
        var bytes = new byte[ChunkSize];
        long index = 0;
        while (true)
        {
            var count = await stream.ReadAsync(bytes, ct);
            await input.Writer.WriteAsync(new(++index, count == 0 ? null : Convert.ToBase64String(bytes, 0, count)), ct);
            if (count == 0)
            {
                input.Writer.TryComplete();
                return;
            }
        }
    }

    public async Task WriteGateway(Stream stream, CancellationToken ct)
    {
        await foreach (var bytes in output.Reader.ReadAllAsync(ct))
            await stream.WriteAsync(bytes, ct);
    }

    private static bool Matches(string expected, string? value) =>
        value?.Length == expected.Length &&
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(value));
}
