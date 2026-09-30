using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;

using Path = System.Windows.Shapes.Path;

namespace Pip.Overlay;

public enum BuddyState { Idle, Listening, Thinking, Speaking, Pointing, Dozing }

/// <summary>
/// The buddy next to the cursor: a glossy blue pointer with a tiny face, a live
/// waveform while listening, bouncing dots while thinking, and a caption bubble
/// with what it's saying. Its top-left corner is the pointer's tip, so moving
/// the window to a point makes the buddy point exactly there.
/// </summary>
public sealed class BuddyWindow
{
    public Window Window { get; }
    public const int WidthDips = 420;
    public const int HeightDips = 190;

    private readonly Canvas root = new() { Width = WidthDips, Height = HeightDips, IsHitTestVisible = false };
    private readonly Path pointer;
    private readonly TextBlock face;
    private readonly Border bubble;
    private readonly TextBlock bubbleText;
    private readonly Border label;
    private readonly TextBlock labelText;
    private readonly StackPanel waveform;
    private readonly StackPanel thinkingDots;
    private readonly Rectangle[] bars = new Rectangle[5];
    private Color accent;

    public BuddyWindow(Color accentColor)
    {
        accent = accentColor;
        Window = WindowStyles.CreateTransparentWindow();
        Window.Width = WidthDips;
        Window.Height = HeightDips;
        Window.Content = root;
        Window.SourceInitialized += (_, _) => WindowStyles.ApplyOverlayStyle(Window, clickThrough: true);

        // The pointer: tip at (0,0), a rounded arrowhead like Clicky's blue cursor.
        pointer = new Path
        {
            Data = Geometry.Parse("M 0,0 L 17,12.5 L 9.5,13.5 L 5.5,21 Z"),
            StrokeThickness = 1.4,
            Stroke = Brushes.White,
            StrokeLineJoin = PenLineJoin.Round,
            Effect = new DropShadowEffect { BlurRadius = 10, ShadowDepth = 1.5, Opacity = 0.45, Color = Color.FromRgb(20, 60, 160) },
        };
        Canvas.SetLeft(pointer, 1);
        Canvas.SetTop(pointer, 1);
        root.Children.Add(pointer);

        face = new TextBlock { Text = "(•‿•)", FontSize = 10.5, Foreground = Brushes.White, FontFamily = new FontFamily("Segoe UI Symbol") };
        var faceChip = new Border { Child = face, CornerRadius = new CornerRadius(8), Padding = new Thickness(5, 1, 5, 2), Background = new SolidColorBrush(Color.FromArgb(235, 25, 27, 31)) };
        Canvas.SetLeft(faceChip, 17);
        Canvas.SetTop(faceChip, 20);
        root.Children.Add(faceChip);

        waveform = new StackPanel { Orientation = Orientation.Horizontal, Visibility = Visibility.Collapsed };
        for (var index = 0; index < bars.Length; index++)
        {
            bars[index] = new Rectangle { Width = 3.5, Height = 4, RadiusX = 1.75, RadiusY = 1.75, Margin = new Thickness(1.5, 0, 1.5, 0), VerticalAlignment = VerticalAlignment.Center, Fill = Brushes.White };
            waveform.Children.Add(bars[index]);
        }
        var waveformChip = new Border { Child = waveform, Height = 22, CornerRadius = new CornerRadius(11), Padding = new Thickness(7, 0, 7, 0) };
        waveformChip.SetBinding(UIElement.VisibilityProperty, new System.Windows.Data.Binding(nameof(Visibility)) { Source = waveform });
        Canvas.SetLeft(waveformChip, 60);
        Canvas.SetTop(waveformChip, 18);
        root.Children.Add(waveformChip);
        this.waveformChip = waveformChip;

        thinkingDots = new StackPanel { Orientation = Orientation.Horizontal, Visibility = Visibility.Collapsed };
        for (var index = 0; index < 3; index++)
        {
            var dot = new Ellipse { Width = 6, Height = 6, Margin = new Thickness(2), Fill = Brushes.White };
            var bounce = new DoubleAnimation(0.25, 1, TimeSpan.FromMilliseconds(420)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, BeginTime = TimeSpan.FromMilliseconds(index * 140) };
            dot.BeginAnimation(UIElement.OpacityProperty, bounce);
            thinkingDots.Children.Add(dot);
        }
        var dotsChip = new Border { Child = thinkingDots, CornerRadius = new CornerRadius(11), Padding = new Thickness(6, 3, 6, 3), Background = new SolidColorBrush(Color.FromArgb(235, 25, 27, 31)) };
        dotsChip.SetBinding(UIElement.VisibilityProperty, new System.Windows.Data.Binding(nameof(Visibility)) { Source = thinkingDots });
        Canvas.SetLeft(dotsChip, 60);
        Canvas.SetTop(dotsChip, 19);
        root.Children.Add(dotsChip);

        bubbleText = new TextBlock { TextWrapping = TextWrapping.Wrap, MaxWidth = 300, FontSize = 13.5, Foreground = Brushes.White, FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI"), LineHeight = 19 };
        bubble = new Border
        {
            Child = bubbleText,
            CornerRadius = new CornerRadius(14),
            Padding = new Thickness(12, 8, 12, 9),
            Background = new SolidColorBrush(Color.FromArgb(240, 22, 24, 28)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(60, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            Effect = new DropShadowEffect { BlurRadius = 16, ShadowDepth = 2, Opacity = 0.35 },
            Visibility = Visibility.Collapsed,
        };
        Canvas.SetLeft(bubble, 22);
        Canvas.SetTop(bubble, 46);
        root.Children.Add(bubble);

        labelText = new TextBlock { FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White };
        label = new Border { Child = labelText, CornerRadius = new CornerRadius(9), Padding = new Thickness(8, 2, 8, 3), Visibility = Visibility.Collapsed };
        Canvas.SetLeft(label, 20);
        Canvas.SetTop(label, 22);
        root.Children.Add(label);

        ApplyAccent(accentColor);
    }

    private readonly Border waveformChip;

    public void ApplyAccent(Color color)
    {
        accent = color;
        var top = Color.FromArgb(255, (byte)Math.Min(255, color.R + 70), (byte)Math.Min(255, color.G + 70), (byte)Math.Min(255, color.B + 40));
        pointer.Fill = new LinearGradientBrush(top, color, 90);
        waveformChip.Background = new LinearGradientBrush(top, color, 90);
        label.Background = new SolidColorBrush(color);
    }

    public void SetState(BuddyState state)
    {
        waveform.Visibility = state == BuddyState.Listening ? Visibility.Visible : Visibility.Collapsed;
        thinkingDots.Visibility = state == BuddyState.Thinking ? Visibility.Visible : Visibility.Collapsed;
        face.Text = state switch
        {
            BuddyState.Listening => "(°o°)",
            BuddyState.Thinking => "(・・?)",
            BuddyState.Speaking => "(^▽^)",
            BuddyState.Pointing => "(☞ﾟ∀ﾟ)",
            BuddyState.Dozing => "(－_－) zzz",
            _ => "(•‿•)",
        };
        if (state != BuddyState.Pointing) label.Visibility = Visibility.Collapsed;
    }

    public void SetLevel(float level)
    {
        var shape = new[] { 0.55, 0.85, 1.0, 0.8, 0.5 };
        for (var index = 0; index < bars.Length; index++) bars[index].Height = 4 + level * 14 * shape[index] * (0.75 + Random.Shared.NextDouble() * 0.5);
    }

    public void SetCaption(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            bubble.Visibility = Visibility.Collapsed;
            return;
        }
        bubbleText.Text = text.Length > 260 ? "…" + text[^259..] : text;
        bubble.Visibility = Visibility.Visible;
    }

    public void SetPointLabel(string? text)
    {
        labelText.Text = text ?? "";
        label.Visibility = string.IsNullOrWhiteSpace(text) ? Visibility.Collapsed : Visibility.Visible;
    }

    public void SetVisible(bool visible)
    {
        var animation = new DoubleAnimation(visible ? 1 : 0, TimeSpan.FromMilliseconds(visible ? 150 : 400));
        root.BeginAnimation(UIElement.OpacityProperty, animation);
    }
}
