namespace FileSharing;

internal sealed class NotificationWorker(NotificationDeliveries deliveries, NotificationProviders providers,
    NotificationVault vault, ILogger<NotificationWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var recovered = false;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        var lastClean = 0L;
        do
        {
            try
            {
                if (!recovered)
                {
                    await deliveries.Recover(stoppingToken);
                    recovered = true;
                }
                if (vault.Enabled)
                {
                    var claimed = await deliveries.Claim(4, stoppingToken);
                    await Task.WhenAll(claimed.Select(row => Send(row, stoppingToken)));
                }
                if (Clock.Now - lastClean >= 600)
                {
                    await deliveries.Clean(stoppingToken);
                    lastClean = Clock.Now;
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                recovered = false;
                logger.LogError(error, "Notification queue maintenance failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task Send(NotificationDeliveryRow row, CancellationToken ct)
    {
        var destination = await deliveries.Destination(row, ct);
        var outcome = destination is null
            ? new NotificationProviderResult("notification_scope_changed")
            : await providers.Send(destination, row.Content, ct);
        // Persist provider acceptance even if shutdown was requested as the reply arrived.
        await deliveries.Complete(row, outcome, destination is null, CancellationToken.None);
    }
}
