using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using Pip.Capture;
using Pip.Overlay;
using Pip.Talk;
using static Pip.Native.NativeMethods;

namespace Pip.Ui;

/// <summary>
/// Double-tap Ctrl: a small text box by the cursor for typing to Pip instead
/// of talking. The reply streams in as selectable text with a copy button and
/// is read aloud too ("library mode").
/// </summary>
public sealed class TextComposer
{
    private readonly TalkController talk;
    private readonly Window window;
    private readonly TextBox input;
    private readonly TextBox reply;
    private readonly Border replyBorder;
    private readonly Button copyButton;
    private IntPtr previousForeground;
    private Task<TurnContext>? contextTask;
    private string? pendingDocumentText;

    public TextComposer(TalkController talk)
    {
        this.talk = talk;
        window = new Window
        {
            WindowStyle = WindowStyle.None,
            AllowsTransparency = true,
            Background = Brushes.Transparent,
            Topmost = true,
            ShowInTaskbar = false,
            SizeToContent = SizeToContent.Height,
            Width = 420,
            ResizeMode = ResizeMode.NoResize,
        };
        window.SourceInitialized += (_, _) => SetWindowDisplayAffinity(new System.Windows.Interop.WindowInteropHelper(window).Handle, WDA_EXCLUDEFROMCAPTURE);

        input = new TextBox
        {
            FontSize = 14,
            Foreground = Brushes.White,
            CaretBrush = Brushes.White,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            AcceptsReturn = false,
            TextWrapping = TextWrapping.Wrap,
            MaxHeight = 120,
        };
        var placeholder = new TextBlock { Text = "ask pip anything…", Foreground = Brushes.Gray, FontSize = 14, IsHitTestVisible = false };
        input.TextChanged += (_, _) => placeholder.Visibility = input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        var inputGrid = new Grid();
        inputGrid.Children.Add(input);
        inputGrid.Children.Add(placeholder);

        reply = new TextBox
        {
            IsReadOnly = true,
            FontSize = 13.5,
            Foreground = Brushes.White,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            TextWrapping = TextWrapping.Wrap,
            MaxHeight = 320,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };
        copyButton = new Button { Content = "copy", Foreground = Brushes.White, Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)), BorderThickness = new Thickness(0), Padding = new Thickness(9, 2, 9, 3), Margin = new Thickness(0, 6, 0, 0), HorizontalAlignment = HorizontalAlignment.Right, Template = NotchPill.RoundedTemplate(), Cursor = Cursors.Hand };
        copyButton.Click += (_, _) => Clipboard.SetText(reply.Text);
        var replyStack = new StackPanel();
        replyStack.Children.Add(reply);
        replyStack.Children.Add(copyButton);
        replyBorder = new Border { Child = replyStack, Visibility = Visibility.Collapsed, Margin = new Thickness(0, 10, 0, 0), Padding = new Thickness(0, 10, 0, 0), BorderThickness = new Thickness(0, 1, 0, 0), BorderBrush = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)) };

        var content = new StackPanel();
        content.Children.Add(inputGrid);
        content.Children.Add(replyBorder);
        window.Content = new Border
        {
            Child = content,
            Margin = new Thickness(12),
            Padding = new Thickness(14, 11, 14, 11),
            CornerRadius = new CornerRadius(16),
            Background = new SolidColorBrush(Color.FromArgb(248, 20, 21, 24)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(55, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            Effect = new DropShadowEffect { BlurRadius = 22, ShadowDepth = 3, Opacity = 0.45 },
        };

        input.KeyDown += async (_, args) =>
        {
            if (args.Key == Key.Escape) Hide();
            if (args.Key != Key.Enter || string.IsNullOrWhiteSpace(input.Text) || contextTask is null) return;
            args.Handled = true;
            var text = input.Text.Trim();
            input.Text = "";
            reply.Text = "";
            replyBorder.Visibility = Visibility.Visible;
            var context = await contextTask;
            var documentText = pendingDocumentText;
            pendingDocumentText = null;
            await talk.SendTextAsync(text, context, documentText);
        };
        window.KeyDown += (_, args) => { if (args.Key == Key.Escape) Hide(); };
        window.Deactivated += (_, _) => { if (string.IsNullOrEmpty(reply.Text)) Hide(); };
        talk.TextDelta += delta =>
        {
            if (window.IsVisible && replyBorder.Visibility == Visibility.Visible) reply.Text = StripTags(reply.Text + delta);
        };
    }

    private static string StripTags(string text) => System.Text.RegularExpressions.Regex.Replace(text, @"\[(POINT|TARGET|HOVER|HIGHLIGHT|SHAPE|OPEN|DONE)(:[^\]]*)?\]\s?", "");

    /// <summary>Opens at the cursor. The screen is captured first, so Pip sees what you were looking at, not the box.</summary>
    public void Open(string? prefill = null, string? documentText = null)
    {
        previousForeground = GetForegroundWindow();
        contextTask = talk.CaptureForTextAsync();
        pendingDocumentText = documentText;
        input.Text = prefill ?? "";
        reply.Text = "";
        replyBorder.Visibility = Visibility.Collapsed;
        var (x, y) = Monitors.CursorPosition();
        window.Show();
        WindowStyles.MovePhysical(window, x + 12, y + 16);
        window.Activate();
        input.Focus();
        input.CaretIndex = input.Text.Length;
    }

    public void Hide()
    {
        if (!window.IsVisible) return;
        window.Hide();
        if (previousForeground != IntPtr.Zero) SetForegroundWindow(previousForeground);
    }
}
