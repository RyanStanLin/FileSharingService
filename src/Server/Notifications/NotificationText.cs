using System.Text;

namespace FileSharing;

internal static class NotificationText
{
    public const int TitleBytes = 180;
    public const int BodyBytes = 2800;

    public static string Limit(string value, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(value) <= maxBytes)
            return value;
        var units = 0;
        var bytes = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            bytes += rune.Utf8SequenceLength;
            if (bytes > maxBytes - 3)
                break;
            units += rune.Utf16SequenceLength;
        }
        return value[..units] + "…";
    }

    public static bool HasUnsupportedControls(string value) =>
        value.Any(c => char.IsControl(c) && c is not ('\t' or '\n' or '\r'));
}
