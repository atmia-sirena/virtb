namespace Pip.Core;

/// <summary>
/// The dictation bubble's language chip: short labels in each language's own
/// script ("हिं", "த", "Hinglish"). Codes come from the speech server
/// (en, hi, hinglish, ta…) or settings (en-IN…).
/// </summary>
public static class LanguageChips
{
    private static readonly Dictionary<string, string> Chips = new(StringComparer.OrdinalIgnoreCase)
    {
        ["en"] = "EN", ["hinglish"] = "Hinglish", ["hi"] = "हिं", ["ta"] = "த", ["te"] = "తె", ["pa"] = "ਪੰ",
        ["bn"] = "বা", ["mr"] = "मरा", ["gu"] = "ગુ", ["kn"] = "ಕ", ["ml"] = "മ", ["or"] = "ଓ", ["as"] = "অ",
        ["ur"] = "اردو", ["ne"] = "ने", ["kok"] = "को", ["mai"] = "मै", ["sa"] = "सं", ["sd"] = "سن", ["ks"] = "کٲ",
        ["doi"] = "डो", ["mni"] = "মৈ", ["brx"] = "बड़", ["sat"] = "ᱥᱟ",
    };

    /// <summary>"en-IN" and "en" are the same language; Hinglish is its own.</summary>
    public static string BaseCode(string code)
    {
        var value = code.Trim().ToLowerInvariant();
        return value == "hinglish" ? value : value.Split('-', '_')[0];
    }

    public static string For(string? code) =>
        string.IsNullOrWhiteSpace(code) ? "" : Chips.TryGetValue(BaseCode(code), out var chip) ? chip : code.ToUpperInvariant();
}
