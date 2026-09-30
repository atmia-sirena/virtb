using System.Text.RegularExpressions;

namespace Pip.Core;

/// <summary>Text handling rules for dictation insertion and speech.</summary>
public static partial class TextRules
{
    private static readonly HashSet<string> terminalProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "WindowsTerminal", "conhost", "cmd", "powershell", "pwsh", "wt", "alacritty", "wezterm-gui", "mintty", "OpenConsole", "Hyper", "Tabby", "WarpTerminal",
    };

    public static bool IsTerminalProcess(string? processName)
    {
        if (string.IsNullOrEmpty(processName)) return false;
        var name = processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? processName[..^4] : processName;
        return terminalProcesses.Contains(name);
    }

    /// <summary>
    /// Final text to insert. Dictation never presses Enter in a terminal, so
    /// newlines become spaces there; em and en dashes are never inserted.
    /// </summary>
    public static string PrepareForInsertion(string text, bool targetIsTerminal)
    {
        var withoutDashes = DashPattern().Replace(text, ", ");
        return targetIsTerminal ? NewlinePattern().Replace(withoutDashes, " ").Trim() : withoutDashes;
    }

    /// <summary>
    /// Splits a beat into speakable chunks so the first audio starts sooner: the
    /// first chunk breaks early at a comma when the sentence is long.
    /// </summary>
    public static List<string> SplitForSpeech(string text, int firstChunkMaxCharacters = 70)
    {
        var chunks = new List<string>();
        foreach (Match sentence in SentencePattern().Matches(text))
        {
            var value = sentence.Value.Trim();
            if (value.Length > 0) chunks.Add(value);
        }
        if (chunks.Count == 0) return chunks;
        if (chunks[0].Length > firstChunkMaxCharacters)
        {
            var comma = chunks[0].IndexOf(", ", 20, StringComparison.Ordinal);
            if (comma > 0 && comma < chunks[0].Length - 12)
            {
                var head = chunks[0][..(comma + 1)];
                var tail = chunks[0][(comma + 2)..];
                chunks[0] = head;
                chunks.Insert(1, tail);
            }
        }
        return chunks;
    }

    [GeneratedRegex(@"\s*[—–]\s*")]
    private static partial Regex DashPattern();

    [GeneratedRegex(@"\s*[\r\n]+\s*")]
    private static partial Regex NewlinePattern();

    [GeneratedRegex(@"[^.!?]+[.!?]*(\s+|$)")]
    private static partial Regex SentencePattern();
}

/// <summary>
/// Learns the user's spellings: when a dictated word is corrected by hand within
/// ~20 seconds (e.g. "cloudy" -> "Clicky"), the corrected spelling joins the
/// personal dictionary so the next cleanup uses it.
/// </summary>
public static class DictionaryLearning
{
    private static readonly char[] separators = { ' ', '\t', '\r', '\n', ',', '.', '!', '?', ';', ':', '"', '(', ')' };

    public static List<string> LearnCorrections(string insertedText, string fieldTextAfterEdits)
    {
        var inserted = insertedText.Split(separators, StringSplitOptions.RemoveEmptyEntries);
        var after = fieldTextAfterEdits.Split(separators, StringSplitOptions.RemoveEmptyEntries);
        var insertedSet = new HashSet<string>(inserted, StringComparer.Ordinal);
        var afterSet = new HashSet<string>(after, StringComparer.Ordinal);
        var learned = new List<string>();
        foreach (var word in inserted)
        {
            if (afterSet.Contains(word) || word.Length < 3) continue;
            // The word disappeared: find what replaced it among words that weren't dictated.
            var replacement = after
                .Where(candidate => !insertedSet.Contains(candidate) && candidate.Length >= 3)
                .Select(candidate => (candidate, distance: Levenshtein(word.ToLowerInvariant(), candidate.ToLowerInvariant())))
                // Mishearings keep the first sound but can differ a lot ("cloudy" -> "Clicky").
                .Where(pair => pair.distance > 0 && (pair.distance <= 2 || (pair.distance <= Math.Max(2, word.Length / 2) && char.ToLowerInvariant(pair.candidate[0]) == char.ToLowerInvariant(word[0]))))
                .OrderBy(pair => pair.distance)
                .Select(pair => pair.candidate)
                .FirstOrDefault();
            if (replacement is not null && !learned.Contains(replacement)) learned.Add(replacement);
        }
        return learned;
    }

    public static int Levenshtein(string left, string right)
    {
        var previous = new int[right.Length + 1];
        var current = new int[right.Length + 1];
        for (var column = 0; column <= right.Length; column++) previous[column] = column;
        for (var row = 1; row <= left.Length; row++)
        {
            current[0] = row;
            for (var column = 1; column <= right.Length; column++)
            {
                var cost = left[row - 1] == right[column - 1] ? 0 : 1;
                current[column] = Math.Min(Math.Min(current[column - 1] + 1, previous[column] + 1), previous[column - 1] + cost);
            }
            (previous, current) = (current, previous);
        }
        return previous[right.Length];
    }
}
