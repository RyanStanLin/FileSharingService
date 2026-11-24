namespace FileSharing;

internal sealed record TerminalView(string Id, string DeviceId, string RootId, string? ConnectionId, bool Interactive,
    string State, bool Connected, bool CanControl, string? CommandId, bool CommandStarted, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt, DateTimeOffset? FinishedAt, string? Code);
internal sealed record TerminalFrame(long Index, string Kind, string? CommandId = null, string? Data = null,
    int? ExitCode = null, string? Code = null, string? Line = null, string? Prompt = null, bool? Interactive = null,
    long? At = null);
internal sealed record TerminalPage(IReadOnlyList<TerminalFrame> Items, long Cursor, bool Closed, bool Truncated,
    bool HasMore, TerminalView Session);
internal sealed record TerminalList(IReadOnlyList<TerminalView> Items, string? NextCursor, TerminalView? Active);
internal sealed record TerminalControl(string? Kind, string? Id, string? CommandId, string? Data, int? Rows, int? Columns);
