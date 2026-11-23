using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FileSharing;

internal sealed record NotificationProviderResult(string? Error, int? HttpStatus = null,
    string? ProviderId = null, bool Transient = false, int RetrySeconds = 0);

internal sealed class NotificationProviders(IHttpClientFactory clients, NotificationOptions options, NotificationVault vault)
{
    public const string Client = "NotificationProviders";
    private static readonly JsonSerializerOptions Json = new(Wire.Json)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<NotificationProviderResult> Send(NotificationChannelRow channel, NotificationMessage message, CancellationToken ct)
    {
        try
        {
            if (channel.Kind == "bark")
            {
                var bark = channel.Bark;
                if (!options.AllowsBark(bark.Server))
                    return new("bark_origin_not_allowed");
                return (await Post(new Uri(new Uri(bark.Server), "push"), new
                {
                    device_key = vault.Open(channel),
                    message.Title,
                    message.Body,
                    bark.Group,
                    bark.Sound,
                    bark.Level
                }, telegram: false, ct)).Outcome;
            }

            var telegram = channel.Telegram;
            var result = await Telegram(vault.Open(channel), "sendMessage", new
            {
                chat_id = ChatValue(telegram.ChatId),
                message_thread_id = telegram.MessageThreadId,
                text = message.Title + "\n" + message.Body,
                disable_notification = telegram.Silent,
                link_preview_options = new { is_disabled = true }
            }, ct);
            return result.Outcome.Error is null
                ? result.Outcome with { ProviderId = Integer(result.Value, "message_id")?.ToString(CultureInfo.InvariantCulture) }
                : result.Outcome;
        }
        catch (Fault failure) when (failure.Code == "notification_credential_unavailable")
        {
            return new(failure.Code);
        }
    }

    public async Task<TelegramVerification> VerifyTelegram(NotificationChannelRow channel, CancellationToken ct)
    {
        var token = vault.Open(channel);
        var bot = await Telegram(token, "getMe", new { }, ct);
        EnsureVerified(bot.Outcome);
        var chat = await Telegram(token, "getChat", new { chat_id = ChatValue(channel.Telegram.ChatId) }, ct);
        EnsureVerified(chat.Outcome);
        if (Integer(bot.Value, "id") is not { } botId || Integer(chat.Value, "id") is not { } chatId ||
            Text(chat.Value, "type") is not { } type || type is not ("private" or "group" or "supergroup" or "channel"))
            throw new Fault(502, "notification_provider_invalid_response");
        var name = Text(bot.Value, "username");
        return new(botId.ToString(CultureInfo.InvariantCulture), name is { Length: <= 64 } ? name : null,
            chatId.ToString(CultureInfo.InvariantCulture), type);
    }

    private static void EnsureVerified(NotificationProviderResult outcome)
    {
        if (outcome.Error is { } error)
            throw new Fault(outcome.Transient ? 503 : 422, error);
    }

    private Task<ProviderReply> Telegram(string token, string method, object payload, CancellationToken ct) =>
        Post(new Uri(options.TelegramOrigin, $"/bot{token}/{method}"), payload, telegram: true, ct);

    private async Task<ProviderReply> Post(Uri uri, object payload, bool telegram, CancellationToken ct)
    {
        try
        {
            using var client = clients.CreateClient(Client);
            using var body = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(payload, Json));
            body.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            using var response = await client.PostAsync(uri, body, ct);
            var status = (int)response.StatusCode;
            var retry = response.Headers.RetryAfter;
            var delay = retry?.Delta ?? (retry?.Date is { } date ? date - DateTimeOffset.UtcNow : TimeSpan.Zero);
            var headerSeconds = (int)Math.Clamp(Math.Ceiling(delay.TotalSeconds), 0, 86400);
            JsonElement document;
            try
            {
                document = await response.Content.ReadFromJsonAsync<JsonElement>(Json, ct);
            }
            catch (JsonException)
            {
                return new(status is >= 200 and < 300
                    ? new("notification_provider_invalid_response", status, Transient: true)
                    : Rejection(status, status, headerSeconds), default);
            }

            var code = Integer(document, telegram ? "error_code" : "code") ?? status;
            var succeeded = response.IsSuccessStatusCode &&
                (telegram ? Get(document, "ok").ValueKind == JsonValueKind.True : Integer(document, "code") == 200);
            if (succeeded)
                return new(new(null, status), telegram ? Get(document, "result") : default);

            if (response.IsSuccessStatusCode && (document.ValueKind != JsonValueKind.Object ||
                (telegram ? Get(document, "ok").ValueKind != JsonValueKind.False : Integer(document, "code") is null)))
                return new(new("notification_provider_invalid_response", status, Transient: true), default);

            var retryAfter = Integer(Get(document, "parameters"), "retry_after") ?? 0;
            return new(Rejection(status, code, (int)Math.Clamp(Math.Max(headerSeconds, retryAfter), 0, 86400)), default);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new(new("notification_provider_timeout", Transient: true), default);
        }
        catch (Exception failure) when (failure is HttpRequestException or IOException)
        {
            return new(new("notification_provider_unreachable", Transient: true), default);
        }
    }

    private static NotificationProviderResult Rejection(int status, long code, int retryAfter)
    {
        if (status == 429 || code == 429)
            return new("notification_provider_rate_limited", status, Transient: true, RetrySeconds: Math.Max(1, retryAfter));
        if (status == 408 || status >= 500 || code == 408 || code is >= 500 and <= 599)
            return new("notification_provider_unavailable", status, Transient: true, RetrySeconds: retryAfter);
        return new("notification_provider_rejected", status);
    }

    private static object ChatValue(string value) =>
        long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number) ? number : value;

    private static JsonElement Get(JsonElement element, string key) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(key, out var value) ? value : default;

    private static long? Integer(JsonElement element, string key) =>
        Get(element, key) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt64(out var number) ? number : null;

    private static string? Text(JsonElement element, string key) =>
        Get(element, key) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private sealed record ProviderReply(NotificationProviderResult Outcome, JsonElement Value);
}
