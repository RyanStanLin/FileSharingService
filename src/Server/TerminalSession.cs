using System.Diagnostics;
using System.Text.Json;

namespace FileSharing;

internal sealed record TerminalView(string Id, string DeviceId, string RootId, string ConnectionId);
internal sealed record TerminalFrame(long Index, string Kind, string? CommandId = null, string? Data = null,
    int? ExitCode = null, string? Code = null, string? Line = null, string? Prompt = null);
internal sealed record TerminalPage(IReadOnlyList<TerminalFrame> Items, long Cursor, bool Closed, bool Truncated);

internal sealed class TerminalSession(TerminalView view, string rootKey, string reviewId)
{
    private const int Capacity = 256;
    private readonly object gate = new();
    private readonly Queue<TerminalFrame> frames = new(Capacity);
    private readonly TaskCompletionSource<string?> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource closed = NewSignal();
    private TaskCompletionSource changed = NewSignal();
    private long agentIndex;
    private long index;
    private long lastInput = Stopwatch.GetTimestamp();
    private string? commandId;
    private string? prompt;
    private bool interruptRequested;

    public TerminalView View { get; } = view;
    public string RootKey { get; } = rootKey;
    public string ReviewId { get; } = reviewId;
    public Task<string?> Ready => ready.Task;
    public Task Closed => closed.Task;

    public bool Idle()
    {
        lock (gate)
            return Stopwatch.GetElapsedTime(lastInput) >= TimeSpan.FromMinutes(30);
    }

    public void Begin(string id, string line)
    {
        lock (gate)
        {
            if (closed.Task.IsCompleted || !ready.Task.IsCompletedSuccessfully)
                throw Fault.Conflict("terminal_closed");
            if (commandId is not null)
                throw Fault.Conflict("terminal_busy");
            commandId = id;
            interruptRequested = false;
            lastInput = Stopwatch.GetTimestamp();
            Append(new(0, "command", id, Line: line, Prompt: prompt));
        }
    }

    public string? InterruptCommand()
    {
        lock (gate)
        {
            if (closed.Task.IsCompleted || commandId is null || interruptRequested)
                return null;
            interruptRequested = true;
            return commandId;
        }
    }

    public void Accept(JsonElement input)
    {
        TerminalFrame part;
        try { part = Wire.Model<TerminalFrame>(input); }
        catch (JsonException) { throw Fault.Bad("invalid_terminal_frame"); }
        lock (gate)
        {
            if (closed.Task.IsCompleted || part.Index <= agentIndex)
                return;
            if (part.Index != agentIndex + 1)
                throw Fault.Bad("invalid_terminal_frame");
            agentIndex = part.Index;
            switch (part.Kind)
            {
                case "ready" when !ready.Task.IsCompleted:
                    prompt = ValidPrompt(part.Prompt);
                    Append(new(0, "ready", Prompt: prompt));
                    ready.TrySetResult(null);
                    break;
                case "output" when commandId is not null && ValidOutput(part.Data):
                    Append(new(0, "output", commandId, Data: part.Data));
                    break;
                case "exit" when commandId is not null && commandId == part.CommandId && part.ExitCode is >= 0 and <= 255:
                    prompt = ValidPrompt(part.Prompt);
                    Append(new(0, "exit", commandId, ExitCode: part.ExitCode, Code: ValidCode(part.Code), Prompt: prompt));
                    commandId = null;
                    break;
                case "error":
                    End(ValidCode(part.Code) ?? "terminal_unavailable");
                    break;
                default:
                    throw Fault.Bad("invalid_terminal_frame");
            }
        }
    }

    public void End(string code)
    {
        lock (gate)
        {
            if (!closed.TrySetResult())
                return;
            ready.TrySetResult(code);
            Append(new(0, "closed", Code: code));
        }
    }

    public TerminalPage Read(long after, out Task next)
    {
        lock (gate)
        {
            if (after < 0 || after > index)
                throw Fault.Bad("invalid_output_cursor");
            next = changed.Task;
            var truncated = frames.TryPeek(out var first) && after < first.Index - 1;
            return new(frames.Where(frame => frame.Index > after).ToArray(), index, closed.Task.IsCompleted, truncated);
        }
    }

    private void Append(TerminalFrame frame)
    {
        if (frames.Count == Capacity)
            frames.Dequeue();
        frames.Enqueue(frame with { Index = ++index });
        var previous = changed;
        changed = NewSignal();
        previous.TrySetResult();
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static bool ValidOutput(string? encoded)
    {
        Span<byte> buffer = stackalloc byte[2048];
        return encoded is { Length: > 0 and <= 2732 } && Convert.TryFromBase64String(encoded, buffer, out var count) && count > 0;
    }

    private static string? ValidCode(string? code) =>
        code is { Length: > 0 and <= 64 } && code.All(c => c is >= 'a' and <= 'z' or '_') ? code : null;

    private static string? ValidPrompt(string? value) =>
        value is { Length: > 0 and <= 512 } && !value.Any(char.IsControl) ? value : null;
}
