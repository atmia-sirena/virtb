namespace Pip.Core;

public readonly record struct PixelRect(int Left, int Top, int Width, int Height)
{
    public int Right => Left + Width;
    public int Bottom => Top + Height;
    public bool Contains(double x, double y) => x >= Left && x < Right && y >= Top && y < Bottom;
}

/// <summary>
/// One monitor as Pip sees it: bounds in physical pixels of the virtual desktop
/// (the process is per-monitor-DPI-v2 aware), its DPI scale, and the size of
/// the screenshot sent to the backend for it.
/// </summary>
public sealed record MonitorLayout(int Index, PixelRect Bounds, double DpiScale, bool IsPrimary, int ImageWidth, int ImageHeight)
{
    /// <summary>Screenshot pixels per physical pixel (the client downscales screenshots).</summary>
    public double ImageScale => (double)ImageWidth / Bounds.Width;
}

/// <summary>Maps between the three spaces Pip uses: screenshot pixels, physical screen pixels, and an overlay window's DIPs.</summary>
public static class CoordinateMapper
{
    /// <summary>Largest side of a screenshot sent to the backend.</summary>
    public const int ScreenshotLongEdge = 1280;

    public static (int Width, int Height) ScreenshotSize(PixelRect bounds, int longEdge = ScreenshotLongEdge)
    {
        var largest = Math.Max(bounds.Width, bounds.Height);
        if (largest <= longEdge) return (bounds.Width, bounds.Height);
        var scale = (double)longEdge / largest;
        return (Math.Max(1, (int)Math.Round(bounds.Width * scale)), Math.Max(1, (int)Math.Round(bounds.Height * scale)));
    }

    public static (double X, double Y) ImageToScreen(MonitorLayout monitor, double imageX, double imageY) =>
        (monitor.Bounds.Left + imageX / monitor.ImageScale, monitor.Bounds.Top + imageY / monitor.ImageScale);

    public static (double X, double Y) ScreenToImage(MonitorLayout monitor, double screenX, double screenY) =>
        ((screenX - monitor.Bounds.Left) * monitor.ImageScale, (screenY - monitor.Bounds.Top) * monitor.ImageScale);

    /// <summary>Physical screen point -> position inside that monitor's overlay window, in WPF DIPs.</summary>
    public static (double X, double Y) ScreenToOverlay(MonitorLayout monitor, double screenX, double screenY) =>
        ((screenX - monitor.Bounds.Left) / monitor.DpiScale, (screenY - monitor.Bounds.Top) / monitor.DpiScale);

    public static double ImageLengthToOverlay(MonitorLayout monitor, double imageLength) => imageLength / monitor.ImageScale / monitor.DpiScale;

    public static MonitorLayout? MonitorAt(IReadOnlyList<MonitorLayout> monitors, double screenX, double screenY) =>
        monitors.FirstOrDefault(monitor => monitor.Bounds.Contains(screenX, screenY));

    /// <summary>Screen rectangle -> [x, y, w, h] in the image pixels of the monitor containing its center.</summary>
    public static (int Screen, int[] Rect)? ScreenRectToImage(IReadOnlyList<MonitorLayout> monitors, PixelRect rect)
    {
        var monitor = MonitorAt(monitors, rect.Left + rect.Width / 2.0, rect.Top + rect.Height / 2.0);
        if (monitor is null) return null;
        var (x, y) = ScreenToImage(monitor, rect.Left, rect.Top);
        return (monitor.Index, new[] { (int)Math.Round(x), (int)Math.Round(y), (int)Math.Round(rect.Width * monitor.ImageScale), (int)Math.Round(rect.Height * monitor.ImageScale) });
    }
}
