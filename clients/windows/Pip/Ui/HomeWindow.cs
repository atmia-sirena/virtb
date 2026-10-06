using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Pip.Ui;

/// <summary>
/// Home: the shared React app (home-web) served by the backend, hosted in
/// WebView2. Closing hides it; Pip keeps running in the background.
/// </summary>
public sealed class HomeWindow
{
    public event Action<string, JsonElement>? MessageReceived;

    private readonly Uri homeUri;
    private Window? window;
    private WebView2? webView;

    public HomeWindow(Uri backendBase)
    {
        homeUri = new Uri(backendBase, "home/");
    }

    public async void Open(string? view = null)
    {
        if (window is null)
        {
            webView = new WebView2 { DefaultBackgroundColor = System.Drawing.Color.FromArgb(241, 241, 240) };
            window = new Window
            {
                Title = "pip",
                Width = 1120,
                Height = 740,
                MinWidth = 760,
                MinHeight = 520,
                Content = webView,
                Background = new SolidColorBrush(Color.FromRgb(241, 241, 240)),
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
            };
            window.Closing += (_, args) =>
            {
                args.Cancel = true;
                window.Hide();
            };
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pip", "webview");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.WebMessageReceived += (_, args) =>
            {
                try
                {
                    var message = JsonDocument.Parse(args.WebMessageAsJson).RootElement;
                    MessageReceived?.Invoke(message.GetProperty("type").GetString() ?? "", message);
                }
                catch (JsonException)
                {
                }
            };
            // Home's own page may use the mic (Settings → Languages → record your test set); nothing else may.
            webView.CoreWebView2.PermissionRequested += (_, args) =>
            {
                if (args.PermissionKind == CoreWebView2PermissionKind.Microphone && new Uri(args.Uri).IsLoopback) args.State = CoreWebView2PermissionState.Allow;
            };
            // Links from agent replies open in the user's browser, not inside Home.
            webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(args.Uri) { UseShellExecute = true });
            };
            webView.Source = new Uri(homeUri, view is null ? "" : $"#{view}");
        }
        else if (view is not null && webView?.CoreWebView2 is not null)
        {
            webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "navigate", view }));
        }
        window.Show();
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        window.Activate();
    }
}
