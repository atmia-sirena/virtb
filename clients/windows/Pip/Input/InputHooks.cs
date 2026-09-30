using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using Pip.Core;
using static Pip.Native.NativeMethods;

namespace Pip.Input;

/// <summary>
/// Listen-only low-level keyboard hook feeding the hold/double-tap state
/// machine. Never swallows keys. The callback returns immediately; signals are
/// dispatched to the UI thread.
/// </summary>
public sealed class HotkeyService : IDisposable
{
    public event Action<HotkeySignal>? Signal;
    public event Action? EscapePressed;

    private readonly HotkeyStateMachine machine = new();
    private readonly LowLevelProc callback;
    private readonly Dispatcher dispatcher;
    private readonly DispatcherTimer tickTimer;
    private IntPtr hook;

    public HotkeyService(Dispatcher dispatcher)
    {
        this.dispatcher = dispatcher;
        callback = HookCallback;
        tickTimer = new DispatcherTimer(TimeSpan.FromMilliseconds(30), DispatcherPriority.Input, (_, _) => Emit(machine.Tick(DateTime.UtcNow)), dispatcher);
    }

    public void Configure(ShortcutsDto shortcuts)
    {
        void Set(string name, string text)
        {
            try
            {
                machine.SetChord(name, HotkeyChord.Parse(text));
            }
            catch (FormatException error)
            {
                Trace.WriteLine($"[hotkeys] {error.Message}");
            }
        }
        Set("talk", shortcuts.Talk);
        Set("dictate", shortcuts.Dictate);
        Set("text", shortcuts.TextMode);
        // Hands-free dictation: double-tap the dictation key, tap again (or Esc) to finish.
        Set("dictate-hands-free", $"{shortcuts.Dictate.Split('(')[0].Trim()} (double-tap)");
    }

    public void Start()
    {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new InvalidOperationException($"keyboard hook failed: {Marshal.GetLastWin32Error()}");
        tickTimer.Start();
    }

    private static HotkeyKey Map(uint virtualKey) => virtualKey switch
    {
        0xA2 => HotkeyKey.LeftCtrl,
        0xA3 => HotkeyKey.RightCtrl,
        0x11 => HotkeyKey.Ctrl,
        0xA4 => HotkeyKey.LeftAlt,
        0xA5 => HotkeyKey.RightAlt,
        0x12 => HotkeyKey.Alt,
        0xA0 => HotkeyKey.LeftShift,
        0xA1 => HotkeyKey.RightShift,
        0x10 => HotkeyKey.Shift,
        0x5B or 0x5C => HotkeyKey.Win,
        0x1B => HotkeyKey.Escape,
        _ => HotkeyKey.Other,
    };

    private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            // Ignore keys Pip itself injects (dictation typing, paste).
            if ((data.flags & LLKHF_INJECTED) == 0)
            {
                var message = (int)wParam;
                var isDown = message is WM_KEYDOWN or WM_SYSKEYDOWN;
                var key = Map(data.vkCode);
                var now = DateTime.UtcNow;
                dispatcher.BeginInvoke(() =>
                {
                    if (isDown && key == HotkeyKey.Escape) EscapePressed?.Invoke();
                    Emit(machine.OnKey(key, isDown, now));
                });
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private void Emit(List<HotkeySignal> signals)
    {
        foreach (var signal in signals) Signal?.Invoke(signal);
    }

    public void Dispose()
    {
        tickTimer.Stop();
        if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
    }
}

/// <summary>Low-level mouse hook used only while a walkthrough waits for the user to click the target.</summary>
public sealed class ClickWatcher : IDisposable
{
    public event Action<int, int>? Clicked;
    private readonly LowLevelProc callback;
    private readonly Dispatcher dispatcher;
    private IntPtr hook;

    public ClickWatcher(Dispatcher dispatcher)
    {
        this.dispatcher = dispatcher;
        callback = HookCallback;
    }

    public bool IsWatching => hook != IntPtr.Zero;

    public void Start()
    {
        if (hook == IntPtr.Zero) hook = SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(null), 0);
    }

    public void Stop()
    {
        if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
    }

    private IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && ((int)wParam == WM_LBUTTONUP || (int)wParam == WM_RBUTTONDOWN))
        {
            var data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            dispatcher.BeginInvoke(() => Clicked?.Invoke(data.pt.X, data.pt.Y));
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    public void Dispose() => Stop();
}
