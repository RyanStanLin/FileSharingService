using System.Net;

namespace FileSharing;

internal static class DemoEndpoints
{
    public static void Map(WebApplication app, Settings settings)
    {
        var websocketOrigin = new UriBuilder(settings.Origin)
        {
            Scheme = settings.Origin.Scheme == "https" ? "wss" : "ws"
        }.Uri.GetLeftPart(UriPartial.Authority);
        var group = app.MapGroup("/demo").ExcludeFromDescription();
        group.MapGet("", (HttpContext context) => Page(context, "index.html", "text/html; charset=utf-8", websocketOrigin));
        group.MapGet("/demo.css", (HttpContext context) => Page(context, "demo.css", "text/css; charset=utf-8", websocketOrigin));
        group.MapGet("/demo.js", (HttpContext context) => Page(context, "demo.js", "text/javascript; charset=utf-8", websocketOrigin));
    }

    private static IResult Page(HttpContext context, string file, string contentType, string websocketOrigin)
    {
        if (context.Connection.RemoteIpAddress is not { } address ||
            !IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address))
            return TypedResults.NotFound();

        context.Response.Headers.ContentSecurityPolicy =
            $"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' {websocketOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
        var content = typeof(DemoEndpoints).Assembly.GetManifestResourceStream($"FileSharing.Demo.{file}")
            ?? throw new InvalidOperationException("Missing local demo resource.");
        return TypedResults.Stream(content, contentType);
    }
}
