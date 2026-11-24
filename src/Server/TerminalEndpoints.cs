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
        group.MapPost("", Open).WithSummary("Open a PTY on an authorized Mac");
        group.MapPost("/{sessionId}/commands", Execute).WithSummary("Submit a terminal command");
        group.MapPost("/{sessionId}/interrupt", Interrupt).WithSummary("Interrupt the current terminal command");
        group.MapPost("/{sessionId}/input", Control).WithSummary("Send PTY keystrokes or window dimensions");
        group.MapGet("/{sessionId}/output", Output).WithSummary("Read terminal output after a cursor");
        group.MapGet("/{sessionId}/ws", Stream).WithSummary("Stream PTY input, output, and exit codes over WebSocket");
        group.MapDelete("/{sessionId}", Close).WithSummary("Close the terminal session");
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
        var session = sessions.Find(await reviews.Require(context, ct), id, sessionId);
        var commandId = await sessions.Execute(session, body.Line, ct);
        return TypedResults.Accepted($"/api/v1/devices/{id}/diagnostics/sessions/{sessionId}/output", new Submission(commandId));
    }

    private static async Task<NoContent> Interrupt(string id, string sessionId, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        await sessions.Interrupt(sessions.Find(await reviews.Require(context, ct), id, sessionId), ct);
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> Control(string id, string sessionId, TerminalControl body, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var session = sessions.Find(await reviews.Require(context, ct), id, sessionId);
        await sessions.Control(session, body, ct);
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> Close(string id, string sessionId, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        sessions.Close(sessions.Find(await reviews.Require(context, ct), id, sessionId));
        return TypedResults.NoContent();
    }

    private static async Task<Ok<TerminalPage>> Output(string id, string sessionId, long? after, HttpContext context,
        ReviewService reviews, TerminalSessions sessions, CancellationToken ct)
    {
        var session = sessions.Find(await reviews.Require(context, ct), id, sessionId);
        await sessions.Authorize(session, ct);
        return TypedResults.Ok(session.Read(after ?? 0, out _));
    }

    private static async Task Stream(string id, string sessionId, long? after, HttpContext context, ReviewService reviews,
        TerminalSessions sessions, CancellationToken ct)
    {
        var session = sessions.Find(await reviews.Require(context, ct), id, sessionId);
        await sessions.Authorize(session, ct);
        var cursor = after ?? 0;
        session.Read(cursor, out _);
        if (!context.WebSockets.IsWebSocketRequest)
            throw Fault.Bad("websocket_required");
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var sending = new SemaphoreSlim(1);
        var receive = ReadControls(session, socket, sessions, Send, stop.Token);
        try
        {
            while (!receive.IsCompleted)
            {
                var page = session.Read(cursor, out var next);
                if (page.Items.Count > 0)
                {
                    await sessions.Authorize(session, stop.Token);
                    await Send(page);
                    cursor = page.Cursor;
                }
                if (page.Closed || await Task.WhenAny(next, receive) == receive)
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

    private static async Task ReadControls(TerminalSession session, WebSocket socket, TerminalSessions sessions,
        Func<object, Task> send, CancellationToken ct)
    {
        while (await SocketWire.Read<TerminalControl>(socket, 8192, ct) is { } input)
        {
            string? code = null;
            try { await sessions.Control(session, input, ct); }
            catch (Fault error) { code = error.Code; }
            await send(new { type = "input", input.Id, code });
        }
    }
}
