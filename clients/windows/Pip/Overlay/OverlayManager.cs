using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Pip.Capture;
using Pip.Core;

namespace Pip.Overlay;

/// <summary>
/// Owns the buddy and the per-monitor draw layers: follows the cursor, flies
/// to targets along a bezier arc, and turns backend visuals (screenshot pixels
/// of screenN) into strokes on the right monitor at the right DPI.
/// </summary>
public sealed class OverlayManager
{
    private readonly BuddyWindow buddy;
    private readonly Dictionary<int, DrawLayer> drawLayers = new();
    private List<DisplayMonitor> monitors = Monitors.Enumerate();
    private Color accent;
    private bool followCursor = true;
    private bool showBuddy = true;
    private bool interactionActive;
    private (double X, double Y) buddyPosition;
    private Flight? flight;
    private (double X, double Y)? parkedAt;
    private readonly DispatcherTimer returnTimer;
    private int shapeSeed = 1;

    private sealed record Flight((double X, double Y) From, (double X, double Y) To, DateTime StartedAt, TimeSpan Duration);

    public OverlayManager(Color accentColor)
    {
        accent = accentColor;
        buddy = new BuddyWindow(accentColor);
        returnTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.6) };
        returnTimer.Tick += (_, _) =>
        {
            returnTimer.Stop();
            ReturnToCursor();
        };
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (_, _) => Application.Current.Dispatcher.BeginInvoke(RebuildDrawLayers);
    }

    public void Start()
    {
        buddy.Window.Show();
        RebuildDrawLayers();
        CompositionTarget.Rendering += OnFrame;
        UpdateVisibility();
    }

    public void ApplySettings(CursorSettingsDto cursor)
    {
        accent = WindowStyles.ParseColor(cursor.Color, Color.FromRgb(0x33, 0x80, 0xFF));
        followCursor = cursor.FollowCursor;
        showBuddy = cursor.ShowBuddy;
        buddy.ApplyAccent(accent);
        foreach (var layer in drawLayers.Values) layer.SetAccent(accent);
        UpdateVisibility();
    }

    private void RebuildDrawLayers()
    {
        foreach (var layer in drawLayers.Values) layer.Clear();
        drawLayers.Clear();
        monitors = Monitors.Enumerate();
        foreach (var monitor in monitors) drawLayers[monitor.Index] = new DrawLayer(monitor, accent);
    }

    /// <summary>Transient mode: when "show pip" is off, the buddy appears only during an interaction.</summary>
    public void SetInteractionActive(bool active)
    {
        interactionActive = active;
        UpdateVisibility();
    }

    private void UpdateVisibility() => buddy.SetVisible(showBuddy || interactionActive || flight is not null || parkedAt is not null);

    public void SetState(BuddyState state) => buddy.SetState(state);
    public void SetLevel(float level) => buddy.SetLevel(level);
    public void SetCaption(string? text) => buddy.SetCaption(text);

    private void OnFrame(object? sender, EventArgs e)
    {
        (double X, double Y) target;
        if (flight is not null)
        {
            var progress = Math.Min(1, (DateTime.UtcNow - flight.StartedAt).TotalMilliseconds / flight.Duration.TotalMilliseconds);
            var point = RoughShapes.FlightPoint(new RoughShapes.Point(flight.From.X, flight.From.Y), new RoughShapes.Point(flight.To.X, flight.To.Y), progress);
            target = (point.X, point.Y);
            if (progress >= 1) flight = null;
        }
        else if (parkedAt is { } parked)
        {
            target = parked;
        }
        else
        {
            if (!followCursor && !interactionActive) return;
            var (cursorX, cursorY) = Monitors.CursorPosition();
            var scale = CoordinateMapper.MonitorAt(monitors.Select(ToLayout).ToList(), cursorX, cursorY)?.DpiScale ?? 1;
            target = (cursorX + 16 * scale, cursorY + 18 * scale);
        }
        if (Math.Abs(target.X - buddyPosition.X) < 0.5 && Math.Abs(target.Y - buddyPosition.Y) < 0.5) return;
        buddyPosition = target;
        WindowStyles.MovePhysical(buddy.Window, (int)Math.Round(target.X), (int)Math.Round(target.Y));
    }

    private static MonitorLayout ToLayout(DisplayMonitor monitor) => new(monitor.Index, monitor.Bounds, monitor.DpiScale, monitor.IsPrimary, monitor.Bounds.Width, monitor.Bounds.Height);

    /// <summary>Flies the buddy's tip to a physical screen point and parks it there.</summary>
    public void FlyTo(double screenX, double screenY, string? label)
    {
        returnTimer.Stop();
        var distance = Math.Sqrt(Math.Pow(screenX - buddyPosition.X, 2) + Math.Pow(screenY - buddyPosition.Y, 2));
        flight = new Flight(buddyPosition, (screenX, screenY), DateTime.UtcNow, TimeSpan.FromMilliseconds(Math.Clamp(280 + distance * 0.35, 350, 800)));
        parkedAt = (screenX, screenY);
        buddy.SetState(BuddyState.Pointing);
        buddy.SetPointLabel(label);
        UpdateVisibility();
    }

    public void ReturnToCursor()
    {
        if (parkedAt is null) return;
        var (cursorX, cursorY) = Monitors.CursorPosition();
        flight = new Flight(buddyPosition, (cursorX + 16, cursorY + 18), DateTime.UtcNow, TimeSpan.FromMilliseconds(450));
        parkedAt = null;
        buddy.SetPointLabel(null);
        buddy.SetState(BuddyState.Idle);
        UpdateVisibility();
    }

    /// <summary>After speaking: keep drawings a moment, then clear and send the buddy home.</summary>
    public void FinishInteraction(bool keepTarget)
    {
        if (!keepTarget)
        {
            returnTimer.Start();
            var clear = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.2) };
            clear.Tick += (_, _) =>
            {
                clear.Stop();
                ClearDrawings();
            };
            clear.Start();
        }
        buddy.SetCaption(null);
    }

    public void ClearDrawings()
    {
        foreach (var layer in drawLayers.Values) layer.Clear();
    }

    /// <summary>
    /// Applies one beat's visual. Returns the physical target (center and radius)
    /// for TARGET/HOVER beats so a walkthrough can watch for the click there.
    /// </summary>
    public (double X, double Y, double Radius)? ApplyVisual(VisualDto visual, IReadOnlyList<MonitorLayout> layouts)
    {
        if (visual.Kind == "open" && visual.Url is { } url)
        {
            // HeyClicky opens links (YouTube, Maps, searches) instead of reading them out.
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                Trace.WriteLine($"[open] {error.Message}");
            }
            return null;
        }
        if (visual.Kind == "done") return null;
        var layout = layouts.FirstOrDefault(candidate => candidate.Index == visual.Screen) ?? layouts.FirstOrDefault();
        if (layout is null || visual.Points.Count == 0 && visual.Rect is null) return null;
        if (!drawLayers.TryGetValue(layout.Index, out var layer)) return null;
        var monitor = layer.Monitor;
        var drawLayout = new MonitorLayout(monitor.Index, monitor.Bounds, monitor.DpiScale, monitor.IsPrimary, layout.ImageWidth, layout.ImageHeight);

        (double X, double Y) ImageToScreen(double[] point) => CoordinateMapper.ImageToScreen(drawLayout, point[0], point[1]);
        RoughShapes.Point ToDips((double X, double Y) screen)
        {
            var (x, y) = CoordinateMapper.ScreenToOverlay(drawLayout, screen.X, screen.Y);
            return new RoughShapes.Point(x, y);
        }
        var seed = shapeSeed++;
        var first = visual.Points.Count > 0 ? ImageToScreen(visual.Points[0]) : (0, 0);
        var radiusDips = visual.Radius is { } radius ? CoordinateMapper.ImageLengthToOverlay(drawLayout, radius) : 26;

        switch (visual.Kind)
        {
            case "point":
                FlyTo(first.X, first.Y, visual.Label);
                return null;
            case "target":
            case "hover":
            {
                var center = ToDips(first);
                layer.DrawTarget(center.X, center.Y, Math.Max(18, radiusDips), seed, dashed: visual.Kind == "hover");
                FlyTo(first.X + radiusDips * 0.7 * drawLayout.DpiScale, first.Y + radiusDips * 0.7 * drawLayout.DpiScale, visual.Label);
                return (first.X, first.Y, Math.Max(18, radiusDips) * drawLayout.DpiScale);
            }
            case "circle":
            {
                var center = ToDips(first);
                var drawing = layer.DrawRing(center.X, center.Y, Math.Max(16, radiusDips), seed);
                FlyTo(first.X + radiusDips * drawLayout.DpiScale, first.Y + radiusDips * drawLayout.DpiScale, visual.Label);
                return null;
            }
            case "highlight" when visual.Rect is { Length: 4 } rect:
            {
                var topLeft = ToDips(CoordinateMapper.ImageToScreen(drawLayout, rect[0], rect[1]));
                var size = (CoordinateMapper.ImageLengthToOverlay(drawLayout, rect[2]), CoordinateMapper.ImageLengthToOverlay(drawLayout, rect[3]));
                var drawing = layer.DrawHighlight(new Rect(topLeft.X, topLeft.Y, size.Item1, size.Item2));
                layer.FadeOut(drawing, TimeSpan.FromSeconds(2.5));
                return null;
            }
            case "arrow" when visual.Points.Count >= 2:
            {
                var end = ImageToScreen(visual.Points[1]);
                layer.DrawArrow(ToDips(first), ToDips(end), seed);
                FlyTo(end.X, end.Y, visual.Label);
                return null;
            }
            case "curve":
                layer.DrawPolyline(RoughShapes.Curve(visual.Points.Select(point => ToDips(ImageToScreen(point))).ToList()));
                return null;
            case "polygon":
                layer.DrawPolyline(RoughShapes.Polygon(visual.Points.Select(point => ToDips(ImageToScreen(point))).ToList(), seed));
                return null;
        }
        return null;
    }
}
