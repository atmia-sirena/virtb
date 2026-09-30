using System.Diagnostics;
using System.Text;
using Microsoft.Win32;
using Pip.Capture;
using Pip.Core;
using static Pip.Native.NativeMethods;

namespace Pip.Platform;

public sealed record ForegroundInfo(IntPtr Window, uint ProcessId, string ProcessName, string Title, bool IsElevated);

public static class ForegroundApp
{
    public static ForegroundInfo Read()
    {
        var window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out var processId);
        var title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        var processName = "";
        var elevated = false;
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process != IntPtr.Zero)
        {
            var name = new StringBuilder(1024);
            var size = name.Capacity;
            if (QueryFullProcessImageName(process, 0, name, ref size)) processName = System.IO.Path.GetFileNameWithoutExtension(name.ToString());
            // Reading an elevated process's token from a normal process fails: that means "admin window".
            if (OpenProcessToken(process, TOKEN_QUERY, out var token))
            {
                elevated = GetTokenInformation(token, TokenElevation, out var isElevated, sizeof(int), out _) && isElevated != 0;
                CloseHandle(token);
            }
            else
            {
                elevated = true;
            }
            CloseHandle(process);
        }
        // We ourselves aren't elevated, so an elevated foreground window is off limits to UIA and SendInput.
        return new ForegroundInfo(window, processId, processName, title.ToString(), elevated && !Environment.IsPrivilegedProcess);
    }

    private static readonly HashSet<string> browsers = new(StringComparer.OrdinalIgnoreCase) { "chrome", "msedge", "brave", "vivaldi", "opera", "arc", "firefox" };

    public static ActiveAppDto Describe(ForegroundInfo info)
    {
        string? url = null;
        if (browsers.Contains(info.ProcessName)) url = UiaSnapshot.BrowserUrl(info.Window);
        var friendlyName = info.ProcessName;
        try
        {
            var process = Process.GetProcessById((int)info.ProcessId);
            friendlyName = process.MainModule?.FileVersionInfo.FileDescription is { Length: > 0 } description ? description : info.ProcessName;
        }
        catch
        {
            // access denied for some processes
        }
        return new ActiveAppDto { Name = friendlyName, Process = info.ProcessName, Title = info.Title, Url = url };
    }
}

/// <summary>
/// Whether Pip should stay quiet: during calls (another app is using the mic),
/// screen sharing and presentations, full-screen apps, and Focus Assist quiet time.
/// </summary>
public static class QuietDetector
{
    public static bool ShouldStayQuiet() => IsMicrophoneInUseByAnotherApp() || IsNotificationStateBusy();

    public static bool IsNotificationStateBusy()
    {
        // QUNS_BUSY=2 (full screen), QUNS_RUNNING_D3D_FULL_SCREEN=3, QUNS_PRESENTATION_MODE=4, QUNS_QUIET_TIME=6
        return SHQueryUserNotificationState(out var state) == 0 && state is 2 or 3 or 4 or 6;
    }

    public static bool IsMicrophoneInUseByAnotherApp()
    {
        try
        {
            const string root = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
            using var consentStore = Registry.CurrentUser.OpenSubKey(root);
            if (consentStore is null) return false;
            var ourExe = Environment.ProcessPath?.Replace('\\', '#') ?? "";
            bool InUse(RegistryKey key) => key.GetValue("LastUsedTimeStop") is long stop && stop == 0 && key.GetValue("LastUsedTimeStart") is long start && start > 0;
            foreach (var appName in consentStore.GetSubKeyNames())
            {
                if (appName == "NonPackaged")
                {
                    using var nonPackaged = consentStore.OpenSubKey(appName)!;
                    foreach (var exeName in nonPackaged.GetSubKeyNames())
                    {
                        if (exeName.Equals(ourExe, StringComparison.OrdinalIgnoreCase) || exeName.Contains("Pip.exe", StringComparison.OrdinalIgnoreCase)) continue;
                        using var app = nonPackaged.OpenSubKey(exeName);
                        if (app is not null && InUse(app)) return true;
                    }
                }
                else
                {
                    using var app = consentStore.OpenSubKey(appName);
                    if (app is not null && InUse(app)) return true;
                }
            }
        }
        catch
        {
            // registry layout differs; assume not in a call
        }
        return false;
    }
}
