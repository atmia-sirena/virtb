using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using static Pip.Native.NativeMethods;

namespace Pip.Overlay;

/// <summary>Helpers shared by Pip's floating windows.</summary>
public static class WindowStyles
{
    /// <summary>
    /// Makes a window a floating overlay: topmost, never activates (no focus
    /// stealing), no taskbar/Alt-Tab entry, optionally click-through, and
    /// excluded from screen capture so Pip never sees itself and never shows
    /// up black in Teams, Loom or OBS.
    /// </summary>
    public static void ApplyOverlayStyle(Window window, bool clickThrough)
    {
        var handle = new WindowInteropHelper(window).EnsureHandle();
        var style = GetWindowLongPtr(handle, GWL_EXSTYLE).ToInt64();
        style |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
        if (clickThrough) style |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
        SetWindowLongPtr(handle, GWL_EXSTYLE, new IntPtr(style));
        SetWindowDisplayAffinity(handle, WDA_EXCLUDEFROMCAPTURE);
    }

    public static void SetClickThrough(Window window, bool clickThrough)
    {
        var handle = new WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        var style = GetWindowLongPtr(handle, GWL_EXSTYLE).ToInt64();
        style = clickThrough ? style | WS_EX_TRANSPARENT | WS_EX_LAYERED : style & ~(long)WS_EX_TRANSPARENT;
        SetWindowLongPtr(handle, GWL_EXSTYLE, new IntPtr(style));
    }

    /// <summary>Moves a window in physical pixels (independent of WPF's per-monitor DIP scaling).</summary>
    public static void MovePhysical(Window window, int x, int y, int width, int height)
    {
        var handle = new WindowInteropHelper(window).Handle;
        if (handle != IntPtr.Zero) SetWindowPos(handle, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
    }

    public static void MovePhysical(Window window, int x, int y)
    {
        var handle = new WindowInteropHelper(window).Handle;
        if (handle == IntPtr.Zero) return;
        GetWindowRect(handle, out var rect);
        SetWindowPos(handle, HWND_TOPMOST, x, y, rect.Right - rect.Left, rect.Bottom - rect.Top, SWP_NOACTIVATE);
    }

    public static Window CreateTransparentWindow()
    {
        return new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = false,
            ShowActivated = false,
            ResizeMode = ResizeMode.NoResize,
            Focusable = false,
        };
    }

    public static Color ParseColor(string hex, Color fallback)
    {
        try
        {
            return (Color)ColorConverter.ConvertFromString(hex);
        }
        catch
        {
            return fallback;
        }
    }
}
