using System.Runtime.InteropServices;
using System.Windows;
using Pip.Core;
using static Pip.Native.NativeMethods;

namespace Pip.Dictation;

/// <summary>
/// Puts text into whatever app the user is in. Short single-line text is typed
/// as Unicode key events (keyboard-layout independent, works in Electron,
/// Chromium and terminals). Multi-line or long text is pasted through the
/// clipboard, then the user's clipboard is restored. Terminals never get
/// newlines, so dictation can't run a command.
/// </summary>
public static class TextInserter
{
    private const int maxTypedCharacters = 300;

    public static async Task InsertAsync(IntPtr targetWindow, string processName, string text)
    {
        var terminal = TextRules.IsTerminalProcess(processName);
        var prepared = TextRules.PrepareForInsertion(text, terminal);
        if (prepared.Length == 0) return;
        if (targetWindow != IntPtr.Zero && GetForegroundWindow() != targetWindow) SetForegroundWindow(targetWindow);
        await Task.Delay(40);
        // Wait until the user has let go of modifier keys, or they'd combine with what we type.
        for (var attempt = 0; attempt < 40 && AnyModifierDown(); attempt++) await Task.Delay(25);
        var multiline = prepared.Contains('\n');
        if (terminal || (!multiline && prepared.Length <= maxTypedCharacters)) TypeUnicode(prepared);
        else await PasteAsync(prepared);
    }

    private static bool AnyModifierDown() =>
        new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }.Any(virtualKey => (GetAsyncKeyState(virtualKey) & 0x8000) != 0);

    public static void TypeUnicode(string text)
    {
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (var character in text)
        {
            if (character == '\r') continue;
            foreach (var flags in new[] { KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP })
            {
                inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wScan = character, dwFlags = flags } } });
            }
        }
        // Send in batches so very long text doesn't overflow the input queue.
        for (var offset = 0; offset < inputs.Count; offset += 200)
        {
            var batch = inputs.Skip(offset).Take(200).ToArray();
            SendInput((uint)batch.Length, batch, Marshal.SizeOf<INPUT>());
        }
    }

    private static void SendKeyChord(params ushort[] virtualKeys)
    {
        var inputs = new List<INPUT>();
        foreach (var key in virtualKeys) inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = key } } });
        foreach (var key in virtualKeys.Reverse()) inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP } } });
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>());
    }

    /// <summary>Must run on the UI (STA) thread: WPF's clipboard requires it.</summary>
    private static async Task PasteAsync(string text)
    {
        var saved = SaveClipboard();
        try
        {
            Clipboard.SetDataObject(new DataObject(DataFormats.UnicodeText, text), copy: true);
        }
        catch (COMException)
        {
            // Another app holds the clipboard open; type instead.
            TypeUnicode(text.Replace("\n", " "));
            return;
        }
        SendKeyChord(0x11, 0x56); // Ctrl+V
        await Task.Delay(450);
        RestoreClipboard(saved);
    }

    private static DataObject? SaveClipboard()
    {
        try
        {
            var current = Clipboard.GetDataObject();
            if (current is null) return null;
            var copy = new DataObject();
            foreach (var format in new[] { DataFormats.UnicodeText, DataFormats.Text, DataFormats.Rtf, DataFormats.Html, DataFormats.FileDrop, DataFormats.Bitmap })
            {
                if (current.GetDataPresent(format)) copy.SetData(format, current.GetData(format));
            }
            return copy;
        }
        catch
        {
            return null;
        }
    }

    private static void RestoreClipboard(DataObject? saved)
    {
        try
        {
            if (saved is null) Clipboard.Clear();
            else Clipboard.SetDataObject(saved, copy: true);
        }
        catch
        {
            // best effort
        }
    }
}
