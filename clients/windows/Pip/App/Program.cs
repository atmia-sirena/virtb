using System.Windows;

namespace Pip.App;

public static class Program
{
    [STAThread]
    public static void Main()
    {
        // One Pip per user session.
        using var singleInstance = new Mutex(true, @"Local\Pip.SingleInstance", out var isFirstInstance);
        if (!isFirstInstance) return;

        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        PipApp? pip = null;
        application.Startup += async (_, _) =>
        {
            try
            {
                pip = new PipApp();
                await pip.StartAsync();
            }
            catch (Exception error)
            {
                MessageBox.Show($"pip couldn't start: {error.Message}", "pip", MessageBoxButton.OK, MessageBoxImage.Error);
                application.Shutdown();
            }
        };
        application.DispatcherUnhandledException += (_, args) =>
        {
            System.Diagnostics.Trace.WriteLine($"[unhandled] {args.Exception}");
            args.Handled = true;
        };
        application.Exit += (_, _) => pip?.Dispose();
        application.Run();
    }
}
