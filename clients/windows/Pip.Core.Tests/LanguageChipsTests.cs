using Pip.Core;
using Xunit;

public class LanguageChipsTests
{
    [Theory]
    [InlineData("en-IN", "EN")]
    [InlineData("en", "EN")]
    [InlineData("hinglish", "Hinglish")]
    [InlineData("hi", "हिं")]
    [InlineData("TA", "த")]
    [InlineData("xx", "XX")]
    [InlineData(null, "")]
    public void ChipsUseEachLanguagesOwnScript(string? code, string chip) => Assert.Equal(chip, LanguageChips.For(code));

    [Fact]
    public void LanguageCycleShortcutParsesAsARightShiftDoubleTap()
    {
        var chord = HotkeyChord.Parse(new ShortcutsDto().LanguageCycle);
        Assert.Equal(HotkeyMode.DoubleTap, chord.Mode);
        Assert.Equal(new[] { HotkeyKey.RightShift }, chord.Keys);
    }

    [Fact]
    public void TypingCapitalsWithShiftNeverCyclesTheLanguage()
    {
        var machine = new HotkeyStateMachine();
        machine.SetChord("language-cycle", HotkeyChord.Parse("RightShift (double-tap)"));
        var now = DateTime.UtcNow;
        var signals = new List<HotkeySignal>();
        // Shift+A, Shift+B quickly: the shift taps are spoiled by the letters.
        foreach (var (key, down, ms) in new[] { (HotkeyKey.RightShift, true, 0), (HotkeyKey.Other, true, 30), (HotkeyKey.Other, false, 60), (HotkeyKey.RightShift, false, 80), (HotkeyKey.RightShift, true, 150), (HotkeyKey.Other, true, 170), (HotkeyKey.Other, false, 200), (HotkeyKey.RightShift, false, 220) })
            signals.AddRange(machine.OnKey(key, down, now.AddMilliseconds(ms)));
        Assert.DoesNotContain(signals, signal => signal.Action == HotkeyAction.DoubleTapped);
        // Two clean taps do.
        var later = now.AddSeconds(2);
        foreach (var (down, ms) in new[] { (true, 0), (false, 80), (true, 200), (false, 270) })
            signals.AddRange(machine.OnKey(HotkeyKey.RightShift, down, later.AddMilliseconds(ms)));
        Assert.Contains(signals, signal => signal.Name == "language-cycle" && signal.Action == HotkeyAction.DoubleTapped);
    }
}
