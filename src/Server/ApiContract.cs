using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace FileSharing;

internal static class ApiContract
{
    public static void Configure(OpenApiOptions options, Settings settings)
    {
        options.AddDocumentTransformer((document, _, _) =>
        {
            document.Info.Title = "FileSharing public API";
            document.Info.Version = "v1";
            document.Info.Description = "Managed macOS devices, passkey sessions, file scopes and transfers.";
            document.Servers =
            [
                new OpenApiServer
                {
                    Url = "/",
                    Description = "The HTTPS origin serving the browser client."
                }
            ];
            document.Components ??= new();
            document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
            document.Components.SecuritySchemes["review"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.ApiKey,
                Name = settings.Cookie,
                In = ParameterLocation.Cookie,
                Description = "HttpOnly administrator session cookie issued after a verified passkey assertion."
            };
            return Task.CompletedTask;
        });
        options.AddOperationTransformer((operation, context, _) =>
        {
            var path = context.Description.RelativePath ?? "";
            var method = context.Description.HttpMethod ?? "";
            operation.OperationId ??= method.ToLowerInvariant() + "_" + string.Join("_",
                path.Split('/', StringSplitOptions.RemoveEmptyEntries).Select(segment => segment.Trim('{', '}').Replace('-', '_')));
            var browserAuth = !path.StartsWith("api/v1/auth/", StringComparison.Ordinal);
            if (browserAuth)
                operation.Security = [new OpenApiSecurityRequirement { [new("review")] = [] }];
            operation.Responses ??= new();
            foreach (var (code, title) in Errors)
                operation.Responses.TryAdd(code, new OpenApiResponse { Description = title });
            if (method == "POST" && path is "api/v1/transfers" or "api/v1/notifications/channels/{id}/test")
                Header(operation, "Idempotency-Key", "A unique key for retrying the same transfer creation.", required: true);
            if ((method == "GET" || method == "HEAD") && path == "api/v1/transfers/{id}/content")
            {
                Header(operation, "Range", "A single HTTP byte range.");
                Header(operation, "If-Range", "The original strong ETag for a resumed response.");
            }
            if (path == "api/v1/events/ws")
            {
                operation.Responses.Remove("200");
                operation.Responses["101"] = new OpenApiResponse { Description = "WebSocket protocol upgrade. See asyncapi.yaml." };
            }
            return Task.CompletedTask;
        });
    }

    private static void Header(OpenApiOperation operation, string name, string description, bool required = false)
    {
        operation.Parameters ??= [];
        operation.Parameters.Add(new OpenApiParameter
        {
            Name = name, In = ParameterLocation.Header, Required = required, Description = description,
            Schema = new OpenApiSchema { Type = JsonSchemaType.String }
        });
    }

    private static readonly (string, string)[] Errors =
    [
        ("400", "Malformed or invalid request"), ("401", "Authentication required"), ("403", "Origin or resource access denied"),
        ("404", "Resource not found"), ("409", "Conflict or device limit"), ("410", "Snapshot or transfer expired"),
        ("412", "File version does not match"), ("413", "Request exceeds configured limits"),
        ("416", "Requested range is outside the file"), ("428", "A resource version is required"),
        ("422", "Device does not support the operation"), ("429", "Rate or concurrency limit"),
        ("503", "Device temporarily unavailable")
    ];
}
