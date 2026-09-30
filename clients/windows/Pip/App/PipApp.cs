using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Pip.Audio;
using Pip.Backend;
using Pip.Core;
using Pip.Dictation;
using Pip.Input;
using Pip.Overlay;
using Pip.Talk;
using Pip.Ui;

namespace Pip.App;

/// <summary>Composition root: starts the backend, wires hotkeys to talk / dictate / text box, and runs the floating UI.</summary>
public sealed class PipApp : IDisposable
{
    private readonly Dispatcher dispatcher = Application.Current.Dispatcher;
    private readonly BackendClient backend;
    private readonly BackendProcess backendProcess = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly string logPath;
    private HotkeyService? hotkeys;
    private OverlayManager? overlay;
    private Speaker? speaker;
    private TalkController? talk;
    private DictationController? dictation;
    private TextComposer? composer;
    private NotchPill? notch;
    private AgentCards? cards;
    private HomeWindow? home;
    private ClientSettingsDto settings = new();

    public PipApp()
    {
        var baseUrl = Environment.GetEnvironmentVariable("PIP_BACKEND_URL") ?? "http://127.0.0.1:8787";
        backend = new BackendClient(baseUrl);
        var stateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pip");
        Directory.CreateDirectory(stateDirectory);
        logPath = Path.Combine(stateDirectory, "pip-client.log");
    }

    private void Log(string line)
    {
        try
        {
            File.AppendAllText(logPath, $"{DateTime.Now:HH:mm:ss} {line}{Environment.NewLine}");
        }
        catch
        {
            // logging is best effort
        }
    }

    public async Task StartAsync()
    {
        Trace.Listeners.Add(new TextWriterTraceListener(logPath));
        Trace.AutoFlush = true;
        if (!await backendProcess.EnsureRunningAsync(backend, Log))
        {
            MessageBox.Show("pip couldn't start its local backend.\n\nRun scripts\\setup.ps1 once, then start pip again.\nDetails are in %APPDATA%\\Pip\\pip-client.log", "pip", MessageBoxButton.OK, MessageBoxImage.Warning);
            Application.Current.Shutdown();
            return;
        }
        await LoadSettingsAsync();

        overlay = new OverlayManager(WindowStyles.ParseColor(settings.Cursor.Color, Color.FromRgb(0x33, 0x80, 0xFF)));
        overlay.ApplySettings(settings.Cursor);
        overlay.Start();
        speaker = new Speaker(backend, dispatcher);
        talk = new TalkController(backend, overlay, speaker, dispatcher);
        talk.SettingsChanged += () => _ = LoadSettingsAsync();
        dictation = new DictationController(backend, overlay, dispatcher);
        composer = new TextComposer(talk);
        home = new HomeWindow(backend.BaseUri);
        home.MessageReceived += OnHomeMessage;
        cards = new AgentCards(backend);
        cards.OpenAgent += agentId => home.Open($"agent:{agentId}");
        notch = new NotchPill();
        notch.OpenHome += view => home.Open(view);
        notch.QuitRequested += () => Application.Current.Shutdown();
        notch.FilesDropped += files =>
        {
            var names = string.Join(", ", files.Select(Path.GetFileName));
            composer.Open($"about {names}: ", NotchPill.ReadDroppedText(files) ?? $"(files: {string.Join("; ", files)})");
        };
        notch.Show();

        hotkeys = new HotkeyService(dispatcher);
        hotkeys.Configure(settings.Shortcuts);
        hotkeys.Signal += OnHotkey;
        hotkeys.EscapePressed += () =>
        {
            if (dictation.IsActive) dictation.Cancel();
            else
            {
                talk.CancelListening();
                talk.StopGuide();
            }
            composer.Hide();
        };
        hotkeys.Start();

        _ = Task.Run(() => FollowEventsAsync(lifetime.Token));
        _ = RefreshAgentsAsync();
        if (!settings.Onboarding.Completed) _ = RunOnboardingAsync();
        Log("pip started");
    }

    private void OnHotkey(HotkeySignal signal)
    {
        switch (signal.Name, signal.Action)
        {
            case ("talk", HotkeyAction.HoldStarted):
                talk!.BeginListening();
                break;
            case ("talk", HotkeyAction.HoldEnded):
                talk!.EndListening();
                break;
            case ("talk", HotkeyAction.HoldCancelled):
                talk!.CancelListening();
                break;
            case ("dictate", HotkeyAction.HoldStarted):
                if (!dictation!.HandsFree) dictation.Begin(handsFree: false);
                break;
            case ("dictate", HotkeyAction.HoldEnded):
                if (!dictation!.HandsFree) dictation.End();
                break;
            case ("dictate", HotkeyAction.HoldCancelled):
                dictation!.Cancel();
                break;
            case ("dictate-hands-free", HotkeyAction.DoubleTapped):
                if (dictation!.HandsFree) dictation.End();
                else dictation.Begin(handsFree: true);
                break;
            case ("text", HotkeyAction.DoubleTapped):
                if (!dictation!.IsActive) composer!.Open();
                break;
        }
    }

    private async Task LoadSettingsAsync()
    {
        try
        {
            var config = await backend.GetAsync<JsonElement>("app-config");
            settings = config.GetProperty("settings").Deserialize<ClientSettingsDto>(PipJson.Options) ?? new ClientSettingsDto();
        }
        catch (Exception error)
        {
            Log($"settings: {error.Message}");
        }
        await dispatcher.InvokeAsync(() =>
        {
            overlay?.ApplySettings(settings.Cursor);
            hotkeys?.Configure(settings.Shortcuts);
        });
    }

    private async Task FollowEventsAsync(CancellationToken cancellation)
    {
        await foreach (var pipEvent in backend.EventsAsync(cancellation))
        {
            await dispatcher.InvokeAsync(() =>
            {
                if (pipEvent.Type.StartsWith("run.")) cards?.Handle(pipEvent);
                if (pipEvent.Type == "announce" && pipEvent.Data.Text is { } text && settings.Agents.AnnounceWhenDone) talk?.Announce(text);
                if (pipEvent.Type == "settings.changed") _ = LoadSettingsAsync();
                if (pipEvent.Type.StartsWith("agent.") || pipEvent.Type.StartsWith("run.")) _ = RefreshAgentsAsync();
            });
        }
    }

    private DateTime lastAgentRefresh;

    private async Task RefreshAgentsAsync()
    {
        if ((DateTime.UtcNow - lastAgentRefresh).TotalMilliseconds < 300) return;
        lastAgentRefresh = DateTime.UtcNow;
        try
        {
            var result = await backend.GetAsync<JsonElement>("agents");
            var agents = result.GetProperty("agents").Deserialize<List<AgentDto>>(PipJson.Options) ?? new();
            await dispatcher.InvokeAsync(() => notch?.SetAgents(agents));
        }
        catch (Exception error)
        {
            Log($"agents: {error.Message}");
        }
    }

    private void OnHomeMessage(string type, JsonElement message)
    {
        var agentId = message.TryGetProperty("agentId", out var id) ? id.GetString() : null;
        switch (type)
        {
            case "talk-start":
                talk?.BeginListening(agentId);
                break;
            case "talk-stop":
                talk?.EndListening();
                break;
            case "settings-changed":
                _ = LoadSettingsAsync();
                break;
            case "start-onboarding":
                _ = RunOnboardingAsync();
                break;
        }
    }

    /// <summary>A short hands-on hello: what the three shortcuts do, said out loud next to the cursor.</summary>
    private async Task RunOnboardingAsync()
    {
        if (overlay is null || speaker is null) return;
        var lines = new[]
        {
            "hey, i'm pip (^_^)/ i live next to your cursor.",
            $"hold {Friendly(settings.Shortcuts.Talk)} and ask me anything about your screen. i'll point at things and draw.",
            $"hold {Friendly(settings.Shortcuts.Dictate)} to type with your voice into any app.",
            $"double-tap {Friendly(settings.Shortcuts.TextMode)} if you'd rather type to me.",
            "and ask me to do things for you. i'll send an agent to work in the background.",
        };
        overlay.SetInteractionActive(true);
        foreach (var line in lines)
        {
            overlay.SetCaption(line);
            overlay.SetState(BuddyState.Speaking);
            speaker.Say(line);
            while (speaker.IsSpeaking) await Task.Delay(150);
            await Task.Delay(400);
        }
        overlay.SetCaption(null);
        overlay.SetState(BuddyState.Idle);
        overlay.SetInteractionActive(false);
        try
        {
            using var request = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Put, new Uri(backend.BaseUri, "me/settings")) { Content = System.Net.Http.Json.JsonContent.Create(new { onboarding = new { completed = true } }) };
            using var client = new System.Net.Http.HttpClient();
            await client.SendAsync(request);
        }
        catch
        {
            // shown again next launch
        }
    }

    private static string Friendly(string shortcut) => shortcut.Split('(')[0].Trim().Replace("+", " plus ").ToLowerInvariant();

    public void Dispose()
    {
        lifetime.Cancel();
        hotkeys?.Dispose();
        speaker?.Dispose();
        backendProcess.Dispose();
        backend.Dispose();
    }
}
