using System.Text.Json;
using Microsoft.AspNetCore.Identity;

namespace FileSharing;

internal sealed record Operator
{
    public string Id { get; init; } = Secrets.Id();
    public string Name { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public long Revision { get; init; }
}

internal sealed class OperatorStore(Database db) : IUserStore<Operator>, IUserPasskeyStore<Operator>
{
    public Task<string> GetUserIdAsync(Operator user, CancellationToken cancellationToken) => Task.FromResult(user.Id);
    public Task<string?> GetUserNameAsync(Operator user, CancellationToken cancellationToken) => Task.FromResult<string?>(user.Name);
    public Task<string?> GetNormalizedUserNameAsync(Operator user, CancellationToken cancellationToken) => Task.FromResult<string?>(user.Name.ToUpperInvariant());

    public Task SetUserNameAsync(Operator user, string? userName, CancellationToken cancellationToken)
    {
        user.Name = userName ?? "";
        return Task.CompletedTask;
    }

    public Task SetNormalizedUserNameAsync(Operator user, string? normalizedName, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<Operator?> FindByIdAsync(string userId, CancellationToken cancellationToken) =>
        db.One<Operator>("SELECT * FROM Operators WHERE Id=@userId", new { userId }, cancellationToken);

    public Task<Operator?> FindByNameAsync(string normalizedUserName, CancellationToken cancellationToken) =>
        db.One<Operator>("SELECT * FROM Operators WHERE Name=@normalizedUserName", new { normalizedUserName }, cancellationToken);

    public async Task<IdentityResult> CreateAsync(Operator user, CancellationToken cancellationToken)
    {
        await db.Execute("INSERT INTO Operators(Id,Name,DisplayName,Revision) VALUES(@Id,@Name,@DisplayName,0)",
            user, cancellationToken);
        return IdentityResult.Success;
    }

    public async Task<IdentityResult> UpdateAsync(Operator user, CancellationToken cancellationToken)
    {
        await db.Execute("UPDATE Operators SET DisplayName=@DisplayName WHERE Id=@Id", user, cancellationToken);
        return IdentityResult.Success;
    }

    public async Task<IdentityResult> DeleteAsync(Operator user, CancellationToken cancellationToken)
    {
        await db.Execute("DELETE FROM Operators WHERE Id=@Id", user, cancellationToken);
        return IdentityResult.Success;
    }

    public async Task AddOrUpdatePasskeyAsync(Operator user, UserPasskeyInfo passkey, CancellationToken cancellationToken)
    {
        var count = await db.Execute("""
            INSERT INTO Passkeys(CredentialId,OperatorId,Data) VALUES(@CredentialId,@Id,@Data)
            ON CONFLICT(CredentialId) DO UPDATE SET Data=excluded.Data WHERE OperatorId=@Id
            """, new { passkey.CredentialId, user.Id, Data = JsonSerializer.Serialize(passkey, Wire.Json) }, cancellationToken);
        if (count != 1)
            throw Fault.Conflict("credential_in_use");
    }

    public async Task<IList<UserPasskeyInfo>> GetPasskeysAsync(Operator user, CancellationToken cancellationToken) =>
        (await db.List<string>("SELECT Data FROM Passkeys WHERE OperatorId=@Id", user, cancellationToken))
            .Select(x => JsonSerializer.Deserialize<UserPasskeyInfo>(x, Wire.Json)!).ToList();

    public Task<Operator?> FindByPasskeyIdAsync(byte[] credentialId, CancellationToken cancellationToken) =>
        db.One<Operator>("SELECT o.* FROM Operators o JOIN Passkeys p ON p.OperatorId=o.Id WHERE p.CredentialId=@credentialId",
            new { credentialId }, cancellationToken);

    public async Task<UserPasskeyInfo?> FindPasskeyAsync(Operator user, byte[] credentialId, CancellationToken cancellationToken)
    {
        var data = await db.One<string>("SELECT Data FROM Passkeys WHERE OperatorId=@Id AND CredentialId=@credentialId",
            new { user.Id, credentialId }, cancellationToken);
        return data is null ? null : JsonSerializer.Deserialize<UserPasskeyInfo>(data, Wire.Json);
    }

    public async Task RemovePasskeyAsync(Operator user, byte[] credentialId, CancellationToken cancellationToken) =>
        await db.Execute("DELETE FROM Passkeys WHERE OperatorId=@Id AND CredentialId=@credentialId",
            new { user.Id, credentialId }, cancellationToken);

    public void Dispose()
    {
    }
}
