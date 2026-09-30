namespace Pip.Core;

/// <summary>Logical keys Pip's shortcuts can use. Left/right variants collapse into the generic key unless named.</summary>
public enum HotkeyKey
{
    Ctrl, LeftCtrl, RightCtrl, Alt, LeftAlt, RightAlt, Shift, LeftShift, RightShift, Win, Escape, Other,
}

public enum HotkeyMode { Hold, DoubleTap }

/// <summary>A shortcut such as "Ctrl+Win (hold)" or "Ctrl (double-tap)".</summary>
public sealed record HotkeyChord(IReadOnlyList<HotkeyKey> Keys, HotkeyMode Mode, string Text)
{
    /// <summary>Parses the settings format: keys joined by "+", then "(hold)" or "(double-tap)".</summary>
    public static HotkeyChord Parse(string text)
    {
        var mode = text.Contains("double", StringComparison.OrdinalIgnoreCase) ? HotkeyMode.DoubleTap : HotkeyMode.Hold;
        var keyPart = text.Split('(')[0];
        var keys = new List<HotkeyKey>();
        foreach (var rawName in keyPart.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var name = rawName.Replace(" ", "").ToLowerInvariant();
            keys.Add(name switch
            {
                "ctrl" or "control" => HotkeyKey.Ctrl,
                "leftctrl" or "lctrl" => HotkeyKey.LeftCtrl,
                "rightctrl" or "rctrl" => HotkeyKey.RightCtrl,
                "alt" => HotkeyKey.Alt,
                "leftalt" or "lalt" => HotkeyKey.LeftAlt,
                "rightalt" or "ralt" or "altgr" => HotkeyKey.RightAlt,
                "shift" => HotkeyKey.Shift,
                "leftshift" or "lshift" => HotkeyKey.LeftShift,
                "rightshift" or "rshift" => HotkeyKey.RightShift,
                "win" or "windows" or "meta" or "super" => HotkeyKey.Win,
                "esc" or "escape" => HotkeyKey.Escape,
                _ => throw new FormatException($"unknown key '{rawName}' in shortcut '{text}'"),
            });
        }
        if (keys.Count == 0) throw new FormatException($"shortcut '{text}' has no keys");
        return new HotkeyChord(keys, mode, text);
    }

    /// <summary>Whether a physical key satisfies one of this chord's logical keys.</summary>
    public static bool Satisfies(HotkeyKey wanted, HotkeyKey pressed) => wanted switch
    {
        HotkeyKey.Ctrl => pressed is HotkeyKey.LeftCtrl or HotkeyKey.RightCtrl or HotkeyKey.Ctrl,
        HotkeyKey.Alt => pressed is HotkeyKey.LeftAlt or HotkeyKey.RightAlt or HotkeyKey.Alt,
        HotkeyKey.Shift => pressed is HotkeyKey.LeftShift or HotkeyKey.RightShift or HotkeyKey.Shift,
        _ => wanted == pressed,
    };
}

public enum HotkeyAction { None, HoldStarted, HoldEnded, HoldCancelled, DoubleTapped }

public sealed record HotkeySignal(string Name, HotkeyAction Action);

/// <summary>
/// Detects holds and double-taps from raw key transitions. RegisterHotKey can't
/// see holds, so the client feeds this from a WH_KEYBOARD_LL hook. It never
/// swallows keys (listen-only, like Clicky's CGEvent tap).
///
/// Holds start after <see cref="HoldDelay"/> so ordinary shortcuts (Ctrl+C,
/// Win+D) don't trigger: any key outside the chord pressed before the delay
/// cancels it. Double-taps are two quick solo taps of the chord.
/// </summary>
public sealed class HotkeyStateMachine
{
    public TimeSpan HoldDelay { get; init; } = TimeSpan.FromMilliseconds(220);
    // Shorter than HoldDelay, so a tap never starts a hold.
    public TimeSpan TapMaxDuration { get; init; } = TimeSpan.FromMilliseconds(200);
    public TimeSpan DoubleTapWindow { get; init; } = TimeSpan.FromMilliseconds(380);

    private readonly Dictionary<string, HotkeyChord> chords = new();
    private readonly HashSet<HotkeyKey> pressedKeys = new();
    private readonly Dictionary<string, HoldState> holds = new();
    private readonly Dictionary<string, TapState> taps = new();

    private sealed class HoldState { public DateTime ArmedAt; public bool Active; public bool Spoiled; }
    private sealed class TapState { public DateTime? DownAt; public DateTime? LastTapAt; public bool Spoiled; }

    public void SetChord(string name, HotkeyChord chord)
    {
        chords[name] = chord;
        holds.Remove(name);
        taps.Remove(name);
    }

    public bool IsHoldActive(string name) => holds.TryGetValue(name, out var state) && state.Active;

    private static bool AllPressed(HotkeyChord chord, IReadOnlyCollection<HotkeyKey> pressed) =>
        chord.Keys.All(wanted => pressed.Any(key => HotkeyChord.Satisfies(wanted, key)));

    private static bool IsPartOf(HotkeyChord chord, HotkeyKey key) => chord.Keys.Any(wanted => HotkeyChord.Satisfies(wanted, key));

    /// <summary>Feeds one key transition; returns the signals it produced.</summary>
    public List<HotkeySignal> OnKey(HotkeyKey key, bool isDown, DateTime now)
    {
        var signals = new List<HotkeySignal>();
        var wasPressed = pressedKeys.Contains(key);
        if (isDown) pressedKeys.Add(key); else pressedKeys.Remove(key);
        var isRepeat = isDown && wasPressed;

        foreach (var (name, chord) in chords)
        {
            if (chord.Mode == HotkeyMode.Hold) UpdateHold(name, chord, key, isDown, isRepeat, now, signals);
            else UpdateDoubleTap(name, chord, key, isDown, isRepeat, now, signals);
        }
        signals.AddRange(Tick(now));
        return signals;
    }

    /// <summary>Call on a timer (~30 ms) so holds start while the keys stay down.</summary>
    public List<HotkeySignal> Tick(DateTime now)
    {
        var signals = new List<HotkeySignal>();
        foreach (var (name, state) in holds)
        {
            if (state.Active || state.Spoiled) continue;
            if (!AllPressed(chords[name], pressedKeys)) continue;
            if (now - state.ArmedAt >= HoldDelay)
            {
                state.Active = true;
                signals.Add(new HotkeySignal(name, HotkeyAction.HoldStarted));
            }
        }
        return signals;
    }

    private void UpdateHold(string name, HotkeyChord chord, HotkeyKey key, bool isDown, bool isRepeat, DateTime now, List<HotkeySignal> signals)
    {
        holds.TryGetValue(name, out var state);
        if (isDown && !isRepeat)
        {
            if (IsPartOf(chord, key))
            {
                if (state is null && AllPressed(chord, pressedKeys) && pressedKeys.All(pressed => IsPartOf(chord, pressed)))
                {
                    holds[name] = new HoldState { ArmedAt = now };
                }
            }
            else if (state is not null)
            {
                // Another key joined the chord: it's a normal shortcut (or the user is typing), not Pip.
                if (state.Active) signals.Add(new HotkeySignal(name, HotkeyAction.HoldCancelled));
                holds.Remove(name);
            }
            else if (pressedKeys.Any(pressed => IsPartOf(chord, pressed)))
            {
                // Chord keys are already down with a foreign key; poison until everything is released.
                holds[name] = new HoldState { ArmedAt = now, Spoiled = true };
            }
        }
        else if (!isDown && state is not null && IsPartOf(chord, key))
        {
            if (state.Active) signals.Add(new HotkeySignal(name, HotkeyAction.HoldEnded));
            holds.Remove(name);
        }
        else if (!isDown && state is { Spoiled: true } && !pressedKeys.Any(pressed => IsPartOf(chord, pressed)))
        {
            holds.Remove(name);
        }
    }

    private void UpdateDoubleTap(string name, HotkeyChord chord, HotkeyKey key, bool isDown, bool isRepeat, DateTime now, List<HotkeySignal> signals)
    {
        if (!taps.TryGetValue(name, out var state)) taps[name] = state = new TapState();
        if (isRepeat) return;
        if (!IsPartOf(chord, key))
        {
            // Any other key spoils the tap sequence (Ctrl+C isn't a tap).
            if (isDown) { state.Spoiled = true; state.LastTapAt = null; }
            return;
        }
        if (isDown)
        {
            if (AllPressed(chord, pressedKeys) && pressedKeys.All(pressed => IsPartOf(chord, pressed)))
            {
                state.DownAt = now;
                state.Spoiled = false;
            }
            return;
        }
        // Key up: completes a tap if it was short and clean.
        if (state.DownAt is { } downAt && !state.Spoiled && now - downAt <= TapMaxDuration)
        {
            if (state.LastTapAt is { } lastTap && now - lastTap <= DoubleTapWindow)
            {
                signals.Add(new HotkeySignal(name, HotkeyAction.DoubleTapped));
                state.LastTapAt = null;
            }
            else
            {
                state.LastTapAt = now;
            }
        }
        else
        {
            state.LastTapAt = null;
        }
        state.DownAt = null;
    }
}
