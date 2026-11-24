using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileSharing;

internal static class TerminalEndpoints
{
    internal sealed record Start(string? RootId);
    internal sealed record Command(string? Line);
    internal sealed record Submission(string CommandId);

    public static void Map(RouteGroupBuilder devices)
    {
        var group = devices.MapGroup("/diagnostics/sessions").WithTags("Terminal");
        group.MapGet("", async (string id, string? cursor, int? limit, HttpContext ctx, ReviewService reviews,
            TerminalSessions sessions, CancellationToken ct) =>
            TypedResults.Ok(await sessions.List(await reviews.Require(ctx, ct), id, cursor, limit, ct)))
            .WithSummary("List saved terminal sessions");
        group.MapPost("", Open).WithSummary("Open a PTY on an authorized Mac");
        group.MapGet("/{sessionId}", async (string id, string sessionId, HttpContext ctx, ReviewService reviews,
            TerminalSessions sessions, CancellationToken ct) =>
            TypedResults.Ok(sessions.View(await sessions.Find(await reviews.Require(ctx, ct), id, sessionId, ct))))
            .WithSummary("Read a terminal session and its connection state");
        group.MapPost("/{sessionId}/commands", Execute).WithSummary("Submit a terminal command");
        group.MapPost("/{sessionId}/interrupt", Interrupt).WithSummary("Interrupt the current terminal command");
        group.MapPost("/{sessionId}/input", Control).WithSummary("Send PTY keystrokes or window dimensions");
        group.MapGet("/{sessionId}/output", Output).WithSummary("Read terminal output after a cursor");
        group.MapGet("/{sessionId}/transcript", Transcript).WithSummary("Download all saved terminal frames as NDJSON");
        group.MapGet("/{sessionId}/ws", Stream).WithSummary("Stream PTY input, output, and exit codes over WebSocket");
        group.MapPost("/{sessionId}/terminate", Terminate).WithSummary("Terminate the PTY and retain its transcript");
        group.MapDelete("/{sessionId}", Delete).WithSummary("Delete a terminated session and its transcript");
    }

    private static async Task<Created<TerminalView>> Open(string id, Start body, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var session = await sessions.Open(await reviews.Require(context, ct), id, body.RootId, ct);
        return TypedResults.Created($"/api/v1/devices/{id}/diagnostics/sessions/{session.Id}/output", session);
    }

    private static async Task<Accepted<Submission>> Execute(string id, string sessionId, Command body, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        var commandId = await sessions.Execute(row, body.Line, ct);
        return TypedResults.Accepted($"/api/v1/devices/{id}/diagnostics/sessions/{sessionId}/output", new Submission(commandId));
    }

    private static async Task<NoContent> Interrupt(string id, string sessionId, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        await sessions.Interrupt(row, ct);
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> Control(string id, string sessionId, TerminalControl body, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        await sessions.Control(await reviews.Require(context, ct), id, sessionId, body, ct);
        return TypedResults.NoContent();
    }

    private static async Task<Accepted> Terminate(string id, string sessionId, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        await sessions.Terminate(row, ct);
        return TypedResults.Accepted($"/api/v1/devices/{id}/diagnostics/sessions/{sessionId}");
    }

    private static async Task<NoContent> Delete(string id, string sessionId, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        await sessions.Delete(row, ct);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<TerminalPage>> Output(string id, string sessionId, long? after, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        return TypedResults.Ok(await sessions.Output(row, after ?? 0, ct));
    }

    private static async Task<PushStreamHttpResult> Transcript(string id, string sessionId, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var row = await sessions.Find(await reviews.Require(context, ct), id, sessionId, ct);
        return TypedResults.Stream(stream => sessions.Transcript(row, stream, ct), "application/x-ndjson", $"terminal-{row.Id}.ndjson");
    }

    private static async Task Stream(string id, string sessionId, long? after, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        var review = await reviews.Require(context, ct);
        var row = await sessions.Find(review, id, sessionId, ct);
        var cursor = after ?? 0;
        if (cursor < 0 || cursor > row.Cursor)
            throw Fault.Bad("invalid_output_cursor");
        if (!context.WebSockets.IsWebSocketRequest)
            throw Fault.Bad("websocket_required");
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var sending = new SemaphoreSlim(1);
        var receive = ReadControls(review, id, sessionId, socket, sessions, Send, stop.Token);
        TerminalView? last = null;
        try
        {
            while (!receive.IsCompleted)
            {
                if (await reviews.ActiveById(review.Id, stop.Token) is null)
                    break;
                row = await sessions.Find(review, id, sessionId, stop.Token);
                var page = await sessions.Output(row, cursor, stop.Token);
                if (page.Items.Count > 0 || page.Session != last)
                {
                    await Send(page);
                    cursor = page.Cursor;
                    last = page.Session;
                }
                if (page.Closed)
                    break;
                if (!page.HasMore && await Task.WhenAny(Task.Delay(200, stop.Token), receive) == receive)
                    break;
            }
            if (receive.IsCompleted)
                await receive;
            await sending.WaitAsync(stop.Token);
            try { await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", stop.Token); }
            finally { sending.Release(); }
        }
        catch (Exception error) when (error is Fault or JsonException or OperationCanceledException or WebSocketException)
        {
            socket.Abort();
        }
        finally
        {
            await stop.CancelAsync();
            try { await receive; }
            catch (Exception error) when (error is Fault or JsonException or OperationCanceledException or WebSocketException) { }
        }

        async Task Send(object value)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
            deadline.CancelAfter(TimeSpan.FromSeconds(5));
            await sending.WaitAsync(deadline.Token);
            try { await SocketWire.Send(socket, value, deadline.Token); }
            finally { sending.Release(); }
        }
    }

    private static async Task ReadControls(Review review, string deviceId, string id, WebSocket socket, TerminalSessions sessions,
        Func<object, Task> send, CancellationToken ct)
    {
        while (await SocketWire.Read<TerminalControl>(socket, 8192, ct) is { } input)
        {
            string? code = null;
            try { await sessions.Control(review, deviceId, id, input, ct); }
            catch (Fault error) { code = error.Code; }
            await send(new { type = "input", input.Id, code });
        }
    }
}
