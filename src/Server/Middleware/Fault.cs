using Microsoft.AspNetCore.Diagnostics;

namespace FileSharing;

internal sealed class Fault(int status, string code) : Exception(code)
{
    public int Status { get; } = status;
    public string Code { get; } = code;

    public static Fault Bad(string code) => new(400, code);
    public static Fault Unauthorized() => new(401, "authentication_required");
    public static Fault Forbidden(string code = "access_denied") => new(403, code);
    public static Fault Missing(string code = "not_found") => new(404, code);
    public static Fault Conflict(string code) => new(409, code);
    public static Fault Unavailable(string code = "device_unavailable") => new(503, code);
}

internal sealed class FaultHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        if (context.Response.HasStarted)
            return false;
        var fault = exception switch
        {
            Fault known => known,
            BadHttpRequestException bad => new Fault(bad.StatusCode, "invalid_request"),
            System.Text.Json.JsonException => Fault.Bad("invalid_json"),
            _ => null
        };
        if (fault is null)
            return false;
        await Results.Problem(statusCode: fault.Status, title: fault.Code,
            extensions: new Dictionary<string, object?> { ["code"] = fault.Code, ["traceId"] = context.TraceIdentifier })
            .ExecuteAsync(context);
        return true;
    }
}
