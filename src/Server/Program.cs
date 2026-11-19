using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;

namespace FileSharing;

public static class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        var settings = Settings.Read(builder.Configuration, builder.Environment);
        builder.Services.AddSingleton(settings);
        builder.Services.AddSingleton(FtpSettings.Read(builder.Configuration, settings));
        builder.Services.AddSingleton<FtpAccounts>();
        builder.Services.AddSingleton<FtpFiles>();
        builder.Services.AddHostedService<FtpGateway>();
        builder.Services.AddSingleton<Database>();
        builder.Services.AddSingleton<ReviewService>();
        builder.Services.AddSingleton<AgentRegistration>();
        builder.Services.AddSingleton<AgentBroker>();
        builder.Services.AddSingleton<AgentIngest>();
        builder.Services.AddSingleton<DeviceService>();
        builder.Services.AddSingleton<EventFeed>();
        builder.Services.AddSingleton<WatchRegistry>();
        builder.Services.AddSingleton<FileService>();
        builder.Services.AddSingleton<TransferService>();
        builder.Services.AddSingleton<JobService>();
        builder.Services.AddSingleton<JobOutputs>();
        builder.Services.AddHostedService<Maintenance>();
        builder.Services.AddExceptionHandler<FaultHandler>();
        builder.Services.AddProblemDetails();
        builder.Services.AddOpenApi("v1", options => ApiContract.Configure(options, settings));
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNameCaseInsensitive = false;
            options.SerializerOptions.MaxDepth = Wire.Json.MaxDepth;
            options.SerializerOptions.AllowDuplicateProperties = false;
        });

        builder.Services.AddIdentityCore<Operator>().AddUserStore<OperatorStore>();
        builder.Services.AddSingleton<IPasswordHasher<FtpAccounts>, PasswordHasher<FtpAccounts>>();
        builder.Services.AddScoped<IPasskeyHandler<Operator>, PasskeyHandler<Operator>>();
        builder.Services.Configure<IdentityPasskeyOptions>(options =>
        {
            options.ServerDomain = settings.Origin.IdnHost;
            options.UserVerificationRequirement = "required";
            options.ResidentKeyRequirement = "required";
            options.AuthenticatorTimeout = TimeSpan.FromMinutes(2);
        });
        builder.Services.Configure<PasswordHasherOptions>(options => options.IterationCount = 210_000);

        builder.Services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
            options.ForwardLimit = 1;
            options.AllowedHosts.Add(settings.Origin.IdnHost);
            options.KnownProxies.Clear();
            options.KnownIPNetworks.Clear();
            foreach (var proxy in settings.Proxies)
                options.KnownProxies.Add(proxy);
            if (settings.Proxies.Length == 0)
                options.ForwardedHeaders = ForwardedHeaders.None;
        });
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;
            options.Limits.MaxRequestBodySize = 2 * 1024 * 1024;
        });
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = 429;
            options.AddPolicy("auth", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 24,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0
                }));
            options.AddPolicy("agent-connect", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = 100,
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0
                }));
        });

        var app = builder.Build();
        app.Services.GetRequiredService<Database>().Initialize();
        app.UseForwardedHeaders();
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
        app.Use(async (context, next) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            if (!settings.LoopbackDevelopment && !context.Request.IsHttps && !context.Request.Path.StartsWithSegments("/health"))
                throw Fault.Forbidden("https_required");
            if (!context.Request.Path.StartsWithSegments("/health") &&
                !string.Equals(context.Request.Host.Host, settings.Origin.IdnHost, StringComparison.OrdinalIgnoreCase))
                throw Fault.Forbidden("invalid_host");
            if (context.Request.Path.StartsWithSegments("/api") &&
                (context.WebSockets.IsWebSocketRequest || !HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method)))
                ReviewService.RequireOrigin(context, settings);
            await next(context);
        });
        if (settings.LoopbackDevelopment && builder.Configuration.GetValue<bool>("FileSharing:BlockAgentWebSocket"))
            app.Use(async (context, next) =>
            {
                if (context.Request.Path == "/agent/v1/ws")
                    context.Response.StatusCode = 426;
                else
                    await next(context);
            });
        app.UseRateLimiter();
        if (settings.LoopbackDevelopment && builder.Configuration.GetValue<bool>("FileSharing:EnableDemo"))
            DemoEndpoints.Map(app, settings);
        app.MapGet("/health/live", () => TypedResults.Ok(new { status = "live" })).ExcludeFromDescription();
        app.MapGet("/health/ready", async (Database db, CancellationToken ct) =>
            TypedResults.Ok(new { ready = await db.One<int>("SELECT 1", null, ct) == 1 })).ExcludeFromDescription();
        app.MapOpenApi().AddEndpointFilter(async (context, next) =>
        {
            if (!app.Environment.IsDevelopment())
                await app.Services.GetRequiredService<ReviewService>().Require(context.HttpContext, context.HttpContext.RequestAborted);
            return await next(context);
        });
        var api = app.MapGroup("/api/v1");
        AuthEndpoints.Map(api);
        ManagementEndpoints.Map(api);
        FtpEndpoints.Map(api);
        DataEndpoints.Map(api);
        AgentEndpoints.Map(app);
        await app.RunAsync();
    }
}
