using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using Pip.Capture;
using Pip.Core;
using Pip.Overlay;

using Path = System.Windows.Shapes.Path;

namespace Pip.Ui;

/// <summary>
/// HeyClicky lives in the Mac notch; Windows has none, so Pip rests as a small
/// black pill hanging from the top centre of the primary monitor. It shows an
/// unread gel badge; hovering peeks at every agent; clicking opens Home; files
/// dropped on it start a chat about them.
/// </summary>
public sealed class NotchPill
{
    public event Action<string?>? OpenHome;
    public event Action<string[]>? FilesDropped;
    public event Action? QuitRequested;

    private readonly Window window;
    private readonly Border shell;
    private readonly TextBlock badge;
    private readonly Border badgeChip;
    private readonly StackPanel peekList;
    private readonly Border peek;
    private List<AgentDto> agents = new();
    private const double collapsedWidth = 168;
    private const double expandedWidth = 340;

    public NotchPill()
    {
        window = WindowStyles.CreateTransparentWindow();
        window.SizeToContent = SizeToContent.Height;
        window.Width = expandedWidth + 20;
        window.AllowDrop = true;
        window.SourceInitialized += (_, _) =>
        {
            WindowStyles.ApplyOverlayStyle(window, clickThrough: false);
            Position();
        };

        var pointer = new Path { Data = Geometry.Parse("M 0,0 L 10,7.5 L 5.6,8 L 3.3,12.5 Z"), Fill = new SolidColorBrush(Color.FromRgb(0x4B, 0x8F, 0xF8)), Margin = new Thickness(0, 1, 7, 0), VerticalAlignment = VerticalAlignment.Center };
        var title = new TextBlock { Text = "pip", Foreground = Brushes.White, FontWeight = FontWeights.Bold, FontSize = 13, VerticalAlignment = VerticalAlignment.Center };
        badge = new TextBlock { Foreground = Brushes.White, FontSize = 10.5, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center };
        badgeChip = new Border
        {
            Child = badge,
            MinWidth = 18,
            Height = 18,
            CornerRadius = new CornerRadius(9),
            Padding = new Thickness(5, 1, 5, 0),
            Margin = new Thickness(8, 0, 0, 0),
            Background = new LinearGradientBrush(Color.FromRgb(0xFF, 0x8A, 0x8A), Color.FromRgb(0xE5, 0x48, 0x4D), 90),
            Visibility = Visibility.Collapsed,
        };
        var header = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Height = 30 };
        header.Children.Add(pointer);
        header.Children.Add(title);
        header.Children.Add(badgeChip);

        peekList = new StackPanel();
        var homeButton = MakeButton("open home", () => OpenHome?.Invoke(null));
        var settingsButton = MakeButton("settings", () => OpenHome?.Invoke("settings:general"));
        var quitButton = MakeButton("quit pip", () => QuitRequested?.Invoke());
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8, 0, 4) };
        buttons.Children.Add(homeButton);
        buttons.Children.Add(settingsButton);
        buttons.Children.Add(quitButton);
        var peekContent = new StackPanel { Margin = new Thickness(12, 2, 12, 10) };
        peekContent.Children.Add(peekList);
        peekContent.Children.Add(new TextBlock { Text = "drop files here to ask about them", Foreground = new SolidColorBrush(Color.FromRgb(0x8A, 0x8F, 0x98)), FontSize = 11.5, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 0) });
        peekContent.Children.Add(buttons);
        peek = new Border { Child = peekContent, Visibility = Visibility.Collapsed, Opacity = 0 };

        var stack = new StackPanel();
        stack.Children.Add(header);
        stack.Children.Add(peek);
        shell = new Border
        {
            Child = stack,
            Width = collapsedWidth,
            HorizontalAlignment = HorizontalAlignment.Center,
            Background = new SolidColorBrush(Color.FromArgb(250, 12, 12, 14)),
            CornerRadius = new CornerRadius(0, 0, 16, 16),
            Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 2, Opacity = 0.35 },
            Cursor = Cursors.Hand,
        };
        window.Content = new Grid { Children = { shell }, Background = Brushes.Transparent };

        shell.MouseEnter += (_, _) => Expand(true);
        shell.MouseLeave += (_, _) => Expand(false);
        header.MouseLeftButtonUp += (_, _) => OpenHome?.Invoke(null);
        window.DragEnter += (_, args) => { args.Effects = args.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; Expand(true); };
        window.Drop += (_, args) =>
        {
            if (args.Data.GetData(DataFormats.FileDrop) is string[] files && files.Length > 0) FilesDropped?.Invoke(files);
            Expand(false);
        };
    }

    private static Button MakeButton(string text, Action onClick)
    {
        var button = new Button
        {
            Content = text,
            Margin = new Thickness(3, 0, 3, 0),
            Padding = new Thickness(10, 3, 10, 4),
            Foreground = Brushes.White,
            Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)),
            BorderThickness = new Thickness(0),
            FontSize = 12,
            Cursor = Cursors.Hand,
        };
        button.Template = RoundedTemplate();
        button.Click += (_, _) => onClick();
        return button;
    }

    internal static ControlTemplate RoundedTemplate()
    {
        var template = new ControlTemplate(typeof(Button));
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(10));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
        presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(presenter);
        template.VisualTree = border;
        return template;
    }

    public void Show()
    {
        window.Show();
        Position();
    }

    private void Position()
    {
        var primary = Monitors.Enumerate().FirstOrDefault(monitor => monitor.IsPrimary);
        if (primary is null) return;
        var widthPhysical = (int)(window.Width * primary.DpiScale);
        WindowStyles.MovePhysical(window, primary.Bounds.Left + (primary.Bounds.Width - widthPhysical) / 2, primary.Bounds.Top);
    }

    private void Expand(bool expanded)
    {
        var duration = TimeSpan.FromMilliseconds(200);
        shell.BeginAnimation(FrameworkElement.WidthProperty, new DoubleAnimation(expanded ? expandedWidth : collapsedWidth, duration) { EasingFunction = new CubicEase() });
        if (expanded)
        {
            RenderPeek();
            peek.Visibility = Visibility.Visible;
        }
        var fade = new DoubleAnimation(expanded ? 1 : 0, duration);
        if (!expanded) fade.Completed += (_, _) => peek.Visibility = Visibility.Collapsed;
        peek.BeginAnimation(UIElement.OpacityProperty, fade);
    }

    public void SetAgents(List<AgentDto> latest)
    {
        agents = latest;
        var unread = agents.Sum(agent => agent.Unread) + agents.Count(agent => agent.Status == "needs_you");
        badge.Text = unread.ToString();
        badgeChip.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (peek.Visibility == Visibility.Visible) RenderPeek();
    }

    private void RenderPeek()
    {
        peekList.Children.Clear();
        var ordered = agents
            .OrderByDescending(agent => agent.Status is "needs_you" ? 3 : agent.Status is "running" or "pending" ? 2 : agent.Unread > 0 ? 1 : 0)
            .ThenByDescending(agent => agent.Pinned)
            .Take(7)
            .ToList();
        if (ordered.Count == 0)
        {
            peekList.Children.Add(new TextBlock { Text = "no agents yet. ask pip to do something (•‿•)", Foreground = Brushes.Gray, FontSize = 12, Margin = new Thickness(0, 4, 0, 4), HorizontalAlignment = HorizontalAlignment.Center });
            return;
        }
        foreach (var agent in ordered)
        {
            var status = agent.Status switch { "running" => "working", "pending" => "starting", "needs_you" => "needs you", "done" => "done", "failed" => "stuck", _ => agent.LastMessage ?? "" };
            var row = new DockPanel { Margin = new Thickness(0, 3, 0, 3), Cursor = Cursors.Hand, Background = Brushes.Transparent };
            var face = new TextBlock { Text = agent.Face, Foreground = Brushes.White, FontSize = 11, Width = 64, VerticalAlignment = VerticalAlignment.Center };
            var name = new TextBlock { Text = agent.Name, Foreground = Brushes.White, FontWeight = FontWeights.SemiBold, FontSize = 12.5 };
            var detail = new TextBlock { Text = status, Foreground = agent.Status == "needs_you" ? new SolidColorBrush(Color.FromRgb(0xF5, 0x9E, 0x0B)) : Brushes.Gray, FontSize = 11.5, TextTrimming = TextTrimming.CharacterEllipsis };
            var text = new StackPanel();
            text.Children.Add(name);
            text.Children.Add(detail);
            DockPanel.SetDock(face, Dock.Left);
            row.Children.Add(face);
            row.Children.Add(text);
            var agentId = agent.Id;
            row.MouseLeftButtonUp += (_, _) => OpenHome?.Invoke($"agent:{agentId}");
            peekList.Children.Add(row);
        }
    }

    /// <summary>Reads small text files so a dropped file can be discussed whole (whole-document understanding).</summary>
    public static string? ReadDroppedText(string[] files)
    {
        var parts = new List<string>();
        var total = 0;
        foreach (var file in files.Take(5))
        {
            try
            {
                var info = new FileInfo(file);
                var textLike = new[] { ".txt", ".md", ".csv", ".json", ".log", ".cs", ".ts", ".js", ".py", ".html", ".xml", ".yml", ".yaml", ".ini", ".toml" }.Contains(info.Extension.ToLowerInvariant());
                if (!textLike || info.Length > 200_000) continue;
                var content = File.ReadAllText(file);
                if (total + content.Length > 60_000) content = content[..Math.Max(0, 60_000 - total)];
                total += content.Length;
                parts.Add($"=== {info.Name} ===\n{content}");
            }
            catch
            {
                // unreadable
            }
        }
        return parts.Count == 0 ? null : string.Join("\n\n", parts);
    }
}
