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
        group.MapGet("/xterm/xterm.css", (HttpContext context) => Page(context, "xterm.xterm.css", "text/css; charset=utf-8", websocketOrigin));
        foreach (var script in new[] { "xterm.mjs", "addon-fit.mjs" })
            group.MapGet("/xterm/" + script, (HttpContext context) => Page(context, "xterm." + script, "text/javascript; charset=utf-8", websocketOrigin));
        foreach (var script in new[] { "demo.js", "device-data.js", "device-jobs.js", "device-records.js", "diagnostic-terminal.js", "dialog-text-fields.js", "gateway.js", "terminal-pty.js", "ui.js" })
            group.MapGet("/" + script, (HttpContext context) => Page(context, script, "text/javascript; charset=utf-8", websocketOrigin));
    }

    private static IResult Page(HttpContext context, string file, string contentType, string websocketOrigin)
    {
        if (context.Connection.RemoteIpAddress is not { } address ||
            !IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address))
            return TypedResults.NotFound();

        var styleNonce = file == "index.html" ? Secrets.New(18) : null;
        var styles = styleNonce is null ? "'self'" : $"'self' 'nonce-{styleNonce}'";
        context.Response.Headers.ContentSecurityPolicy =
            $"default-src 'none'; script-src 'self'; style-src {styles}; img-src 'self'; connect-src 'self' {websocketOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
        var content = typeof(DemoEndpoints).Assembly.GetManifestResourceStream($"FileSharing.Demo.{file}")
            ?? throw new InvalidOperationException("Missing local demo resource.");
        if (styleNonce is not null)
        {
            using var html = new StreamReader(content);
            return TypedResults.Content(html.ReadToEnd().Replace("FILESHARING_STYLE_NONCE", styleNonce, StringComparison.Ordinal), contentType);
        }
        return TypedResults.Stream(content, contentType);
    }
}
