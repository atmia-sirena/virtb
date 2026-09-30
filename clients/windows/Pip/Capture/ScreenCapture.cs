using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Pip.Core;
using static Pip.Native.NativeMethods;

namespace Pip.Capture;

/// <summary>A physical monitor: its handle, bounds in physical pixels and DPI scale.</summary>
public sealed record DisplayMonitor(IntPtr Handle, int Index, PixelRect Bounds, double DpiScale, bool IsPrimary, string DeviceName);

public static class Monitors
{
    /// <summary>All monitors, primary first, then left to right (screen0 is always the primary).</summary>
    public static List<DisplayMonitor> Enumerate()
    {
        var found = new List<DisplayMonitor>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr handle, IntPtr _, ref RECT _, IntPtr _) =>
        {
            var info = new MONITORINFOEX { cbSize = Marshal.SizeOf<MONITORINFOEX>() };
            if (!GetMonitorInfo(handle, ref info)) return true;
            var dpiScale = GetDpiForMonitor(handle, 0, out var dpiX, out _) == 0 ? dpiX / 96.0 : 1.0;
            var bounds = new PixelRect(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right - info.rcMonitor.Left, info.rcMonitor.Bottom - info.rcMonitor.Top);
            found.Add(new DisplayMonitor(handle, 0, bounds, dpiScale, (info.dwFlags & MONITORINFOF_PRIMARY) != 0, info.szDevice));
            return true;
        }, IntPtr.Zero);
        return found
            .OrderByDescending(monitor => monitor.IsPrimary)
            .ThenBy(monitor => monitor.Bounds.Left)
            .ThenBy(monitor => monitor.Bounds.Top)
            .Select((monitor, index) => monitor with { Index = index })
            .ToList();
    }

    public static (int X, int Y) CursorPosition()
    {
        GetCursorPos(out var point);
        return (point.X, point.Y);
    }
}

public sealed record CapturedScreen(DisplayMonitor Monitor, MonitorLayout Layout, byte[] Jpeg);

/// <summary>
/// Hotkey-time screenshots of every monitor. GDI StretchBlt downscales in one
/// step (fast, ~10-20 ms per monitor) and respects WDA_EXCLUDEFROMCAPTURE, so
/// Pip's own overlays never appear. Images live only in memory; they are
/// never written to disk or logs.
/// </summary>
public static class ScreenCapturer
{
    public static List<CapturedScreen> CaptureAll(int longEdge = CoordinateMapper.ScreenshotLongEdge)
    {
        var screens = new List<CapturedScreen>();
        foreach (var monitor in Monitors.Enumerate())
        {
            var (width, height) = CoordinateMapper.ScreenshotSize(monitor.Bounds, longEdge);
            var layout = new MonitorLayout(monitor.Index, monitor.Bounds, monitor.DpiScale, monitor.IsPrimary, width, height);
            screens.Add(new CapturedScreen(monitor, layout, CaptureMonitor(monitor.Bounds, width, height)));
        }
        return screens;
    }

    public static byte[] CaptureMonitor(PixelRect bounds, int width, int height, int jpegQuality = 80)
    {
        var screenDc = GetDC(IntPtr.Zero);
        var memoryDc = CreateCompatibleDC(screenDc);
        var header = new BITMAPINFOHEADER
        {
            biSize = Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = width,
            biHeight = -height, // top-down rows
            biPlanes = 1,
            biBitCount = 32,
        };
        var bitmap = CreateDIBSection(screenDc, ref header, 0, out var bits, IntPtr.Zero, 0);
        var previous = SelectObject(memoryDc, bitmap);
        try
        {
            SetStretchBltMode(memoryDc, HALFTONE);
            StretchBlt(memoryDc, 0, 0, width, height, screenDc, bounds.Left, bounds.Top, bounds.Width, bounds.Height, SRCCOPY | CAPTUREBLT);
            var stride = width * 4;
            var source = BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgr32, null, bits, stride * height, stride);
            var encoder = new JpegBitmapEncoder { QualityLevel = jpegQuality };
            encoder.Frames.Add(BitmapFrame.Create(source));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            return stream.ToArray();
        }
        finally
        {
            SelectObject(memoryDc, previous);
            DeleteObject(bitmap);
            DeleteDC(memoryDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    public static List<ScreenCaptureDto> ToDtos(IEnumerable<CapturedScreen> screens, (int X, int Y) cursor)
    {
        return screens.Select(screen =>
        {
            var onThisScreen = screen.Monitor.Bounds.Contains(cursor.X, cursor.Y);
            PointDto? cursorPoint = null;
            if (onThisScreen)
            {
                var (x, y) = CoordinateMapper.ScreenToImage(screen.Layout, cursor.X, cursor.Y);
                cursorPoint = new PointDto { X = Math.Round(x), Y = Math.Round(y) };
            }
            return new ScreenCaptureDto
            {
                Index = screen.Monitor.Index,
                Label = screen.Monitor.IsPrimary ? "primary" : screen.Monitor.DeviceName.TrimStart('\\', '.'),
                Width = screen.Layout.ImageWidth,
                Height = screen.Layout.ImageHeight,
                Image = Convert.ToBase64String(screen.Jpeg),
                IsCursorScreen = onThisScreen,
                Cursor = cursorPoint,
            };
        }).ToList();
    }
}
