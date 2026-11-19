namespace FileSharing;

internal sealed class Maintenance(Database db, AgentBroker broker, WatchRegistry watches, Settings settings, ILogger<Maintenance> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await db.Execute("""
            UPDATE Jobs SET State='failed',Error='server_restarted',Finished=@Now WHERE State='queued';
            UPDATE Transfers SET State='failed',Error='server_restarted',Updated=@Now WHERE State='preparing'
            """, new { Now = Clock.Now }, stoppingToken);

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        long lastClean = 0;
        do
        {
            try
            {
                await broker.Expire(stoppingToken);
                await watches.Renew(stoppingToken);
                if (Clock.Now - lastClean >= 600)
                {
                    await Clean(stoppingToken);
                    lastClean = Clock.Now;
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                logger.LogError(error, "Maintenance iteration failed");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task Clean(CancellationToken ct)
    {
        var now = Clock.Now;
        await db.Execute("""
            DELETE FROM Challenges WHERE Expires<@now;
            DELETE FROM Activations WHERE Expires<@history;
            DELETE FROM AgentTokens WHERE Expires<@now;
            DELETE FROM AgentReceipts WHERE At<@yesterday;
            DELETE FROM Events WHERE At<@history OR (Topic='files.changed' AND At<@watchHistory);
            DELETE FROM Events WHERE Sequence < COALESCE((SELECT seq-250000 FROM sqlite_sequence WHERE name='Events'),0);
            DELETE FROM Audit WHERE At<@audit;
            DELETE FROM Jobs WHERE Created<@history;
            DELETE FROM Reviews WHERE Expires<@history;
            DELETE FROM FtpResumes WHERE Updated<@yesterday;
            UPDATE Transfers SET State='failed',Error='transfer_expired',Updated=@now
                WHERE Updated<@yesterday AND (State='ready' OR (Kind='archive' AND State='completed'));
            DELETE FROM Transfers WHERE Updated<@history;
            """, new { now, yesterday = now - 86400, history = now - 30 * 86400, watchHistory = now - 900, audit = now - 90 * 86400 }, ct);
        var directory = Path.Combine(settings.DataDirectory, "archives");
        if (!Directory.Exists(directory))
            return;
        foreach (var file in Directory.EnumerateFiles(directory))
        {
            var stamp = File.GetLastWriteTimeUtc(file);
            if (DateTime.UtcNow - stamp > TimeSpan.FromHours(24))
                File.Delete(file);
        }
    }
}
