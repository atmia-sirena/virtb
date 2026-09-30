using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Pip.Backend;
using Pip.Capture;
using Pip.Core;
using Pip.Overlay;

namespace Pip.Ui;

/// <summary>
/// Floating cards in the top-right corner, one per running agent: progress,
/// the 5-second cancel window, permission prompts (Allow once / Always allow /
/// Not now), results with an open button, and retry on failure. Cards never
/// take focus; done cards tuck away after a few seconds.
/// </summary>
public sealed class AgentCards
{
    public event Action<string>? OpenAgent;

    private readonly BackendClient backend;
    private readonly Window window;
    private readonly StackPanel stack = new() { Width = 330 };
    private readonly Dictionary<string, Border> cardsByRun = new();

    public AgentCards(BackendClient backend)
    {
        this.backend = backend;
        window = WindowStyles.CreateTransparentWindow();
        window.SizeToContent = SizeToContent.WidthAndHeight;
        window.Content = new Border { Child = stack, Padding = new Thickness(10) };
        window.SourceInitialized += (_, _) => WindowStyles.ApplyOverlayStyle(window, clickThrough: false);
        window.SizeChanged += (_, _) => Position();
    }

    private void Position()
    {
        var primary = Monitors.Enumerate().FirstOrDefault(monitor => monitor.IsPrimary);
        if (primary is null) return;
        var widthPhysical = (int)(window.ActualWidth * primary.DpiScale);
        WindowStyles.MovePhysical(window, primary.Bounds.Right - widthPhysical - (int)(8 * primary.DpiScale), primary.Bounds.Top + (int)(44 * primary.DpiScale));
    }

    public void Handle(PipEventDto pipEvent)
    {
        var run = pipEvent.Data.Run;
        var agent = pipEvent.Data.Agent;
        if (run is null || agent is null) return;
        switch (pipEvent.Type)
        {
            case "run.started":
            case "run.step":
            case "run.message":
            case "run.permission":
            case "run.done":
            case "run.failed":
                Render(run, agent, pipEvent.Data.CancelWindowSeconds);
                break;
            case "run.cancelled":
                Remove(run.Id);
                break;
        }
    }

    private void Remove(string runId)
    {
        if (!cardsByRun.Remove(runId, out var card)) return;
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(250));
        fade.Completed += (_, _) =>
        {
            stack.Children.Remove(card);
            if (stack.Children.Count == 0) window.Hide();
        };
        card.BeginAnimation(UIElement.OpacityProperty, fade);
    }

    private static TextBlock Text(string text, double size = 12.5, Brush? color = null, FontWeight? weight = null) => new()
    {
        Text = text,
        FontSize = size,
        Foreground = color ?? Brushes.White,
        FontWeight = weight ?? FontWeights.Normal,
        TextWrapping = TextWrapping.Wrap,
        Margin = new Thickness(0, 2, 0, 2),
    };

    private static Button CardButton(string text, bool primary, Action onClick)
    {
        var button = new Button
        {
            Content = text,
            Margin = new Thickness(0, 6, 6, 0),
            Padding = new Thickness(11, 4, 11, 5),
            Foreground = Brushes.White,
            BorderThickness = new Thickness(0),
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Cursor = Cursors.Hand,
            Background = primary ? new LinearGradientBrush(Color.FromRgb(0x7D, 0xB4, 0xFF), Color.FromRgb(0x1F, 0x63, 0xE0), 90) : new SolidColorBrush(Color.FromArgb(45, 255, 255, 255)),
            Template = NotchPill.RoundedTemplate(),
        };
        button.Click += (_, _) => onClick();
        return button;
    }

    private void Render(RunDto run, AgentDto agent, int? cancelWindowSeconds)
    {
        if (!cardsByRun.TryGetValue(run.Id, out var card))
        {
            card = new Border
            {
                CornerRadius = new CornerRadius(16),
                Padding = new Thickness(14, 11, 14, 12),
                Margin = new Thickness(0, 0, 0, 8),
                Background = new SolidColorBrush(Color.FromArgb(245, 20, 21, 24)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(50, 255, 255, 255)),
                BorderThickness = new Thickness(1),
                Effect = new DropShadowEffect { BlurRadius = 20, ShadowDepth = 3, Opacity = 0.4 },
                Opacity = 0,
            };
            cardsByRun[run.Id] = card;
            stack.Children.Insert(0, card);
            card.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(200)));
            if (!window.IsVisible)
            {
                window.Show();
                Position();
            }
        }
        var content = new StackPanel();
        var header = new DockPanel();
        var face = Text(agent.Face, 12);
        face.Margin = new Thickness(0, 1, 8, 0);
        DockPanel.SetDock(face, Dock.Left);
        header.Children.Add(face);
        var close = Text("×", 15, Brushes.Gray);
        close.Cursor = Cursors.Hand;
        close.MouseLeftButtonUp += (_, _) => Remove(run.Id);
        DockPanel.SetDock(close, Dock.Right);
        header.Children.Add(close);
        header.Children.Add(Text(agent.Name, 13.5, weight: FontWeights.Bold));
        content.Children.Add(header);

        var gray = new SolidColorBrush(Color.FromRgb(0xA9, 0xAD, 0xB3));
        switch (run.Status)
        {
            case "pending":
            {
                var seconds = cancelWindowSeconds ?? 5;
                var countdown = Text($"starting in {seconds}s", 12, gray);
                content.Children.Add(Text(run.Prompt.Length > 120 ? run.Prompt[..120] + "…" : run.Prompt, 12, gray));
                content.Children.Add(countdown);
                var buttons = new WrapPanel();
                buttons.Children.Add(CardButton("cancel", false, () => _ = backend.PostAsync($"runs/{run.Id}/cancel", null)));
                content.Children.Add(buttons);
                var remaining = seconds;
                var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
                timer.Tick += (_, _) =>
                {
                    remaining--;
                    countdown.Text = remaining > 0 ? $"starting in {remaining}s" : "starting…";
                    if (remaining <= 0) timer.Stop();
                };
                timer.Start();
                break;
            }
            case "running":
            {
                var step = run.Steps.LastOrDefault()?.Text ?? "working…";
                content.Children.Add(Text(step.Length > 140 ? step[..140] + "…" : step, 12, gray));
                var progress = new ProgressBar { IsIndeterminate = true, Height = 3, Margin = new Thickness(0, 6, 0, 0), Foreground = new SolidColorBrush(Color.FromRgb(0x4B, 0x8F, 0xF8)), Background = new SolidColorBrush(Color.FromArgb(30, 255, 255, 255)), BorderThickness = new Thickness(0) };
                content.Children.Add(progress);
                var buttons = new WrapPanel();
                buttons.Children.Add(CardButton("open", false, () => OpenAgent?.Invoke(agent.Id)));
                buttons.Children.Add(CardButton("stop", false, () => _ = backend.PostAsync($"runs/{run.Id}/cancel", null)));
                content.Children.Add(buttons);
                break;
            }
            case "needs_you" when run.Permission is { } permission:
            {
                content.Children.Add(Text("wants to:", 12, new SolidColorBrush(Color.FromRgb(0xF5, 0x9E, 0x0B)), FontWeights.SemiBold));
                content.Children.Add(Text(permission.Summary.Length > 220 ? permission.Summary[..220] + "…" : permission.Summary, 12.5));
                var buttons = new WrapPanel();
                buttons.Children.Add(CardButton("allow once", true, () => _ = backend.PostAsync($"runs/{run.Id}/permission", new { decision = "once" })));
                buttons.Children.Add(CardButton("always allow", false, () => _ = backend.PostAsync($"runs/{run.Id}/permission", new { decision = "always" })));
                buttons.Children.Add(CardButton("not now", false, () => _ = backend.PostAsync($"runs/{run.Id}/permission", new { decision = "deny" })));
                content.Children.Add(buttons);
                break;
            }
            case "done":
            {
                content.Children.Add(Text(run.Summary ?? "done", 12.5));
                if (run.Files.Count > 0) content.Children.Add(Text($"{run.Files.Count} file{(run.Files.Count > 1 ? "s" : "")} ready", 12, new SolidColorBrush(Color.FromRgb(0x7D, 0xB4, 0xFF))));
                var buttons = new WrapPanel();
                buttons.Children.Add(CardButton("open", true, () => { OpenAgent?.Invoke(agent.Id); Remove(run.Id); }));
                content.Children.Add(buttons);
                var hide = new DispatcherTimer { Interval = TimeSpan.FromSeconds(14) };
                hide.Tick += (_, _) => { hide.Stop(); Remove(run.Id); };
                hide.Start();
                break;
            }
            case "failed":
            {
                content.Children.Add(Text(run.Error ?? "got stuck", 12, new SolidColorBrush(Color.FromRgb(0xFF, 0x63, 0x69))));
                var buttons = new WrapPanel();
                buttons.Children.Add(CardButton("retry", true, () => { _ = backend.PostAsync($"runs/{run.Id}/retry", null); Remove(run.Id); }));
                buttons.Children.Add(CardButton("open", false, () => OpenAgent?.Invoke(agent.Id)));
                content.Children.Add(buttons);
                break;
            }
            default:
                content.Children.Add(Text(run.Status, 12, gray));
                break;
        }
        card.Child = content;
    }
}
