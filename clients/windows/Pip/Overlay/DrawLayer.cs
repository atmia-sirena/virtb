using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using Pip.Capture;
using Pip.Core;

using Path = System.Windows.Shapes.Path;

namespace Pip.Overlay;

/// <summary>
/// One click-through, full-screen, capture-excluded window per monitor for the
/// hand-drawn layer: rings, arrows, highlights, polygons and walkthrough
/// targets. Shown only while something is drawn.
/// </summary>
public sealed class DrawLayer
{
    public DisplayMonitor Monitor { get; }
    private readonly Window window;
    private readonly Canvas canvas = new() { IsHitTestVisible = false };
    private Color accent;

    public DrawLayer(DisplayMonitor monitor, Color accentColor)
    {
        Monitor = monitor;
        accent = accentColor;
        window = WindowStyles.CreateTransparentWindow();
        window.Content = canvas;
        window.SourceInitialized += (_, _) =>
        {
            WindowStyles.ApplyOverlayStyle(window, clickThrough: true);
            WindowStyles.MovePhysical(window, monitor.Bounds.Left, monitor.Bounds.Top, monitor.Bounds.Width, monitor.Bounds.Height);
        };
    }

    public void SetAccent(Color color) => accent = color;

    public bool HasDrawings => canvas.Children.Count > 0;

    private void EnsureShown()
    {
        if (!window.IsVisible)
        {
            window.Show();
            WindowStyles.MovePhysical(window, Monitor.Bounds.Left, Monitor.Bounds.Top, Monitor.Bounds.Width, Monitor.Bounds.Height);
        }
    }

    public void Clear()
    {
        canvas.Children.Clear();
        if (window.IsVisible) window.Hide();
    }

    /// <summary>Fades out and removes one drawing after a delay (highlights clear ~2 s after they appear).</summary>
    public void FadeOut(UIElement element, TimeSpan after)
    {
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(350)) { BeginTime = after };
        fade.Completed += (_, _) =>
        {
            canvas.Children.Remove(element);
            if (canvas.Children.Count == 0) window.Hide();
        };
        element.BeginAnimation(UIElement.OpacityProperty, fade);
    }

    private Brush Stroke => new SolidColorBrush(accent);

    private static PointCollection ToPoints(IEnumerable<RoughShapes.Point> points) => new(points.Select(point => new Point(point.X, point.Y)));

    private Polyline Pen(IEnumerable<RoughShapes.Point> points, double thickness = 3.2) => new()
    {
        Points = ToPoints(points),
        Stroke = Stroke,
        StrokeThickness = thickness,
        StrokeLineJoin = PenLineJoin.Round,
        StrokeStartLineCap = PenLineCap.Round,
        StrokeEndLineCap = PenLineCap.Round,
        Effect = new DropShadowEffect { BlurRadius = 6, ShadowDepth = 0, Opacity = 0.35, Color = accent },
    };

    /// <summary>Animates a stroke "being drawn" by revealing it along its length.</summary>
    private static void DrawOn(Shape shape, double length)
    {
        shape.StrokeDashArray = new DoubleCollection { length / shape.StrokeThickness, length / shape.StrokeThickness };
        shape.StrokeDashOffset = length / shape.StrokeThickness;
        shape.BeginAnimation(Shape.StrokeDashOffsetProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(420)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
    }

    private static double Length(IReadOnlyList<RoughShapes.Point> points)
    {
        double total = 0;
        for (var index = 1; index < points.Count; index++) total += Math.Sqrt(Math.Pow(points[index].X - points[index - 1].X, 2) + Math.Pow(points[index].Y - points[index - 1].Y, 2));
        return total;
    }

    private UIElement AddStroke(IReadOnlyList<RoughShapes.Point> points, double thickness = 3.2)
    {
        var line = Pen(points, thickness);
        canvas.Children.Add(line);
        DrawOn(line, Length(points));
        return line;
    }

    // All inputs below are overlay DIPs within this monitor.

    public UIElement DrawRing(double centerX, double centerY, double radius, int seed)
    {
        EnsureShown();
        return AddStroke(RoughShapes.Ring(centerX, centerY, radius * 1.12, radius * 0.92, seed));
    }

    public UIElement DrawArrow(RoughShapes.Point from, RoughShapes.Point to, int seed)
    {
        EnsureShown();
        var (shaft, left, right) = RoughShapes.Arrow(from, to, seed);
        var group = new Canvas();
        foreach (var part in new[] { shaft, left, right })
        {
            var line = Pen(part);
            group.Children.Add(line);
            DrawOn(line, Length(part));
        }
        canvas.Children.Add(group);
        return group;
    }

    public UIElement DrawPolyline(IReadOnlyList<RoughShapes.Point> points)
    {
        EnsureShown();
        return AddStroke(points);
    }

    public UIElement DrawHighlight(Rect rect)
    {
        EnsureShown();
        var box = new Rectangle
        {
            Width = rect.Width + 12,
            Height = rect.Height + 12,
            RadiusX = 10,
            RadiusY = 10,
            Fill = new SolidColorBrush(Color.FromArgb(40, accent.R, accent.G, accent.B)),
            Stroke = Stroke,
            StrokeThickness = 2.5,
            Opacity = 0,
        };
        Canvas.SetLeft(box, rect.X - 6);
        Canvas.SetTop(box, rect.Y - 6);
        canvas.Children.Add(box);
        box.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(200)));
        return box;
    }

    /// <summary>A walkthrough target: a ring plus a soft pulse, inviting the click Pip is waiting for.</summary>
    public UIElement DrawTarget(double centerX, double centerY, double radius, int seed, bool dashed)
    {
        EnsureShown();
        var group = new Canvas();
        var pulse = new Ellipse { Width = radius * 2, Height = radius * 2, Stroke = Stroke, StrokeThickness = 2, Opacity = 0.6 };
        Canvas.SetLeft(pulse, centerX - radius);
        Canvas.SetTop(pulse, centerY - radius);
        pulse.RenderTransformOrigin = new Point(0.5, 0.5);
        var scale = new ScaleTransform(1, 1);
        pulse.RenderTransform = scale;
        var grow = new DoubleAnimation(1, 1.35, TimeSpan.FromMilliseconds(1100)) { RepeatBehavior = RepeatBehavior.Forever };
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
        pulse.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0.6, 0, TimeSpan.FromMilliseconds(1100)) { RepeatBehavior = RepeatBehavior.Forever });
        group.Children.Add(pulse);
        var ringPoints = RoughShapes.Ring(centerX, centerY, radius, radius, seed);
        var ring = Pen(ringPoints);
        if (dashed) ring.StrokeDashArray = new DoubleCollection { 2, 2 };
        else DrawOn(ring, Length(ringPoints));
        group.Children.Add(ring);
        canvas.Children.Add(group);
        return group;
    }
}
