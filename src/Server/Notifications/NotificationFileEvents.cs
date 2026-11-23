using System.IO.Enumeration;
using System.Text.Json;

namespace FileSharing;

/// <summary>A managed root and relative directory. Name filters apply to its direct child entries.</summary>
[System.Text.Json.Serialization.JsonUnmappedMemberHandling(System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow)]
internal sealed record NotificationFileFilter(string RootId, string Path, string? NameGlob, string? EntryKind);

internal static class NotificationFileEvents
{
    public const string Topic = "files.changed";
    public const string Purpose = "notification";
    public const string DirectoryChanged = "file.directoryChanged";

    private static readonly NotificationVariable[] Folder =
    [
        new("directory.rootId", "The FileSharing root grant UUID."),
        new("directory.path", "The watched directory relative to the root. Empty for the root itself.")
    ];

    private static readonly NotificationVariable[] Entry =
    [
        .. Folder,
        new("file.name", "The entry name after the change, or its last name when removed."),
        new("file.path", "The entry path relative to the root."),
        new("file.oldName", "Previous name when renamed."),
        new("file.oldPath", "Previous path when renamed."),
        new("file.kind", "Entry kind reported by the Agent."),
        new("file.extension", "Extension without a leading dot."),
        new("file.size", "File size in bytes."),
        new("file.modifiedAt", "Entry modification time.")
    ];

    public static NotificationEventType[] Catalogue() =>
    [
        NotificationCatalog.Entry("file.added", "A child entry appeared in the watched directory.", Entry, ["file"]),
        NotificationCatalog.Entry("file.removed", "A child entry disappeared from the watched directory.", Entry, ["file"]),
        NotificationCatalog.Entry("file.renamed", "A child entry was renamed within the watched directory.", Entry, ["file"]),
        NotificationCatalog.Entry("file.modified", "A child entry's content or metadata changed.", Entry, ["file"]),
        NotificationCatalog.Entry(DirectoryChanged, "A batch of changes was observed in the watched directory.",
            [.. Folder, new("directory.changeCount", "Number of identified changes, when available."),
                new("directory.changeKind", "Delta, coalesced changes, or directory unavailable.")], ["file"])
    ];

    public static NotificationFileFilter? Validate(NotificationFileFilter? filter, bool required)
    {
        if ((filter is not null) != required)
            throw Fault.Bad("notification_file_scope_mismatch");
        if (filter is null)
            return null;
        var root = Secrets.Identifier(filter.RootId);
        if (filter.Path is null)
            throw Fault.Bad("invalid_path");
        var path = FileService.PathKey(filter.Path);
        if (filter.NameGlob is { } pattern && (pattern.Length is < 1 or > 255 || pattern.Contains('/') || pattern.Contains('\\') ||
                pattern.Any(char.IsControl)) ||
            filter.EntryKind is not (null or "file" or "directory" or "symlink" or "other"))
            throw Fault.Bad("invalid_notification_file_filter");
        return filter with { RootId = root, Path = path };
    }

    public static bool Matches(NotificationSignal signal, NotificationFileFilter? filter)
    {
        if (filter is null)
            return false;
        if (signal.Type == DirectoryChanged)
            return true;
        if (filter.EntryKind is { } kind && signal.Fields.GetValueOrDefault("file.kind") != kind)
            return false;
        var glob = filter.NameGlob;
        return glob is null || MatchesName(signal.Fields.GetValueOrDefault("file.name")) ||
            MatchesName(signal.Fields.GetValueOrDefault("file.oldName"));

        bool MatchesName(string? name) => name is not null && FileSystemName.MatchesSimpleExpression(glob, name, ignoreCase: false);
    }

    public static IReadOnlyList<NotificationSignal> Parse(Watch watch, JsonElement payload, long now)
    {
        var stamp = NotificationSignals.Get(payload, "occurredAt");
        if (stamp.ValueKind != JsonValueKind.String || !stamp.TryGetDateTimeOffset(out var at) ||
            now - at.ToUnixTimeSeconds() is < -300 or > 600)
            return [];
        var kind = NotificationSignals.Text(payload, "kind");
        if (kind == "resync_required")
        {
            var reason = NotificationSignals.Text(payload, "reason");
            return reason is "coalesced" or "unavailable" ? [Directory(watch, at, reason, null)] : [];
        }
        var changes = NotificationSignals.Get(payload, "changes");
        if (kind != "delta" || changes.ValueKind != JsonValueKind.Array || changes.GetArrayLength() is < 1 or > 100)
            return [];
        var found = new List<NotificationSignal>();
        foreach (var change in changes.EnumerateArray())
            if (EntryChange(watch, change, at) is { } edited)
                found.Add(edited);
        if (found.Count > 0)
            found.Add(Directory(watch, at, "delta", found.Count));
        return found;
    }

    private static NotificationSignal? EntryChange(Watch watch, JsonElement change, DateTimeOffset at)
    {
        var type = NotificationSignals.Text(change, "kind") switch
        {
            "added" => "file.added",
            "removed" => "file.removed",
            "renamed" => "file.renamed",
            "updated" => "file.modified",
            _ => null
        };
        if (type is null)
            return null;
        var entry = NotificationSignals.Get(change, "entry");
        var path = NotificationSignals.Text(entry, "path", 3000);
        var name = ChildName(watch.Path, path);
        if (name is null)
            return null;
        var oldPath = NotificationSignals.Text(change, "fromPath", 3000);
        var oldName = type == "file.renamed" ? ChildName(watch.Path, oldPath) : null;
        if (type == "file.renamed" && (oldName is null || oldName == name))
            return null;

        return new(type, at, NotificationSignals.Fields(
            ("directory.rootId", watch.RootId), ("directory.path", watch.Path),
            ("file.name", name), ("file.path", path), ("file.oldName", oldName), ("file.oldPath", oldName is null ? null : oldPath),
            ("file.kind", NotificationSignals.Text(entry, "kind")), ("file.extension", NotificationSignals.Text(entry, "extension")),
            ("file.size", NotificationSignals.Value(entry, "size")), ("file.modifiedAt", NotificationSignals.Text(entry, "modifiedAt"))));
    }

    private static string? ChildName(string parent, string? path)
    {
        if (path is null || path.Contains('\\'))
            return null;
        var separator = path.LastIndexOf('/');
        if (!path.AsSpan(0, Math.Max(separator, 0)).SequenceEqual(parent.AsSpan()) ||
            (separator < 0) != (parent.Length == 0))
            return null;
        var name = path[(separator + 1)..];
        return name.Length != 0 && name is not ("." or "..") && !name.StartsWith(".filesharing-", StringComparison.OrdinalIgnoreCase)
            ? name : null;
    }

    private static NotificationSignal Directory(Watch watch, DateTimeOffset at, string kind, int? count) =>
        new(DirectoryChanged, at, NotificationSignals.Fields(
            ("directory.rootId", watch.RootId), ("directory.path", watch.Path),
            ("directory.changeKind", kind), ("directory.changeCount", count?.ToString(System.Globalization.CultureInfo.InvariantCulture))));
}
