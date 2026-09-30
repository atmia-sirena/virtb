using Pip.Capture;
using Pip.Core;
using Pip.Platform;

namespace Pip.Talk;

/// <summary>Everything captured at the moment a turn starts: screens, UI elements, the app, the cursor.</summary>
public sealed class TurnContext
{
    public required string TurnId { get; init; }
    public required ForegroundInfo Foreground { get; init; }
    public List<CapturedScreen> Screens { get; init; } = new();
    public List<ScreenElementDto> Elements { get; init; } = new();
    public ActiveAppDto? ActiveApp { get; init; }
    public CursorDto? Cursor { get; init; }
    public string? SelectedText { get; init; }
    public (int X, int Y) CursorPhysical { get; init; }

    public List<MonitorLayout> Layouts => Screens.Select(screen => screen.Layout).ToList();

    /// <summary>Captures on a worker thread (~50-150 ms): screenshots, then the UIA tree, the app and selection.</summary>
    public static Task<TurnContext> CaptureAsync(ForegroundInfo foreground) => Task.Run(() =>
    {
        var cursor = Monitors.CursorPosition();
        var screens = ScreenCapturer.CaptureAll();
        var layouts = screens.Select(screen => screen.Layout).ToList();
        CursorDto? cursorDto = null;
        var cursorLayout = CoordinateMapper.MonitorAt(layouts, cursor.X, cursor.Y);
        if (cursorLayout is not null)
        {
            var (x, y) = CoordinateMapper.ScreenToImage(cursorLayout, cursor.X, cursor.Y);
            cursorDto = new CursorDto { Screen = cursorLayout.Index, X = Math.Round(x), Y = Math.Round(y) };
        }
        // Admin windows can't be read from a normal process; skip the tree rather than hang.
        var elements = foreground.IsElevated ? new List<ScreenElementDto>() : UiaSnapshot.Capture(foreground.Window, layouts);
        return new TurnContext
        {
            TurnId = Guid.NewGuid().ToString("N"),
            Foreground = foreground,
            Screens = screens,
            Elements = elements,
            ActiveApp = ForegroundApp.Describe(foreground),
            Cursor = cursorDto,
            SelectedText = foreground.IsElevated ? null : UiaSnapshot.SelectedText(),
            CursorPhysical = cursor,
        };
    });

    public List<ScreenCaptureDto> ScreenDtos() => ScreenCapturer.ToDtos(Screens, CursorPhysical);
}
