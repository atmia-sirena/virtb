using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows.Threading;
using Pip.Audio;
using Pip.Backend;
using Pip.Capture;
using Pip.Core;
using Pip.Overlay;
using Pip.Platform;

namespace Pip.Dictation;

/// <summary>
/// Hold to dictate into any app (or double-tap for hands-free): the local speech
/// models stream the words into the buddy's bubble with a language chip
/// (double-tap Right Shift to switch language), a faithful local cleanup runs on
/// release, and the text is typed or pasted into the app you were in. Every
/// session is backed up locally before insertion, and corrections you make in
/// the next 20 seconds teach the personal dictionary.
/// </summary>
public sealed class DictationController
{
    private readonly BackendClient backend;
    private readonly OverlayManager overlay;
    private readonly Dispatcher dispatcher;
    private SpeechToText? speechToText;
    private ForegroundInfo? target;
    private bool active;
    // Set by the language-cycle hotkey; overrides language ID for this utterance.
    private string? forcedLanguage;

    public bool HandsFree { get; private set; }

    public DictationController(BackendClient backend, OverlayManager overlay, Dispatcher dispatcher)
    {
        this.backend = backend;
        this.overlay = overlay;
        this.dispatcher = dispatcher;
    }

    public bool IsActive => active;

    public async void Begin(bool handsFree)
    {
        if (active)
        {
            // A second trigger ends a hands-free session.
            if (HandsFree) End();
            return;
        }
        target = ForegroundApp.Read();
        if (target.IsElevated)
        {
            overlay.SetInteractionActive(true);
            overlay.SetCaption("that window is running as admin, so i can't type into it.");
            _ = Task.Delay(3000).ContinueWith(_ => dispatcher.BeginInvoke(() => { overlay.SetCaption(null); overlay.SetInteractionActive(false); }));
            return;
        }
        active = true;
        HandsFree = handsFree;
        overlay.SetInteractionActive(true);
        overlay.SetState(BuddyState.Listening);
        overlay.SetCaption(handsFree ? "dictating… tap again to finish" : null);
        speechToText = new SpeechToText(backend);
        speechToText.LevelChanged += level => dispatcher.BeginInvoke(() => overlay.SetLevel(level));
        speechToText.PartialTranscript += text => dispatcher.BeginInvoke(() =>
        {
            if (active) overlay.SetCaption(text);
        });
        speechToText.LanguageDetected += code => dispatcher.BeginInvoke(() =>
        {
            if (active && forcedLanguage is null) overlay.SetLanguage(LanguageChips.For(code));
        });
        forcedLanguage = null;
        try
        {
            await speechToText.StartAsync(new { app = ForegroundApp.Describe(target) });
        }
        catch (Exception error)
        {
            active = false;
            overlay.SetCaption($"i can't hear you: {error.Message}");
        }
    }

    public async void End()
    {
        if (!active || speechToText is null || target is null) return;
        active = false;
        HandsFree = false;
        overlay.SetState(BuddyState.Thinking);
        string raw;
        string? sessionId;
        string? language;
        try
        {
            raw = await speechToText.FinishAsync(forcedLanguage);
            sessionId = speechToText.LastSessionId;
            language = forcedLanguage ?? speechToText.Language;
        }
        finally
        {
            speechToText.Dispose();
            speechToText = null;
        }
        if (string.IsNullOrWhiteSpace(raw))
        {
            Done();
            return;
        }
        Backup(raw);
        var text = raw;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var result = await backend.PostAsync<JsonElement>("v2/dictation/cleanup", new { text = raw, app = ForegroundApp.Describe(target), sessionId, language }, timeout.Token);
            text = result.GetProperty("text").GetString() ?? raw;
        }
        catch (Exception error)
        {
            Trace.WriteLine($"[dictation] cleanup failed, inserting raw transcript: {error.Message}");
        }
        await TextInserter.InsertAsync(target.Window, target.ProcessName, text);
        Done();
        _ = LearnFromCorrectionsAsync(text);
    }

    /// <summary>
    /// Double-tap Right Shift: switch to the next of your languages. While dictating it
    /// re-decodes this utterance in that language; either way the app remembers it.
    /// </summary>
    public async void CycleLanguage()
    {
        var app = ForegroundApp.Describe(target ?? ForegroundApp.Read());
        try
        {
            var result = await backend.PostAsync<JsonElement>("v2/speech/language-cycle", new { app, current = forcedLanguage ?? speechToText?.Language });
            var code = result.GetProperty("language").GetString();
            var chip = result.TryGetProperty("chip", out var value) ? value.GetString() : LanguageChips.For(code);
            if (active) forcedLanguage = code;
            overlay.SetInteractionActive(true);
            overlay.SetLanguage(chip);
            if (!active)
            {
                overlay.SetCaption($"dictating in {chip} here");
                _ = Task.Delay(1500).ContinueWith(_ => dispatcher.BeginInvoke(() =>
                {
                    if (active) return;
                    overlay.SetCaption(null);
                    overlay.SetLanguage(null);
                    overlay.SetInteractionActive(false);
                }));
            }
        }
        catch (Exception error)
        {
            Trace.WriteLine($"[dictation] language switch failed: {error.Message}");
        }
    }

    public void Cancel()
    {
        if (!active) return;
        active = false;
        HandsFree = false;
        speechToText?.Cancel();
        speechToText = null;
        Done();
    }

    private void Done()
    {
        forcedLanguage = null;
        overlay.SetState(BuddyState.Idle);
        overlay.SetCaption(null);
        overlay.SetLanguage(null);
        overlay.SetInteractionActive(false);
    }

    /// <summary>Long dictation is saved before insertion so nothing is lost if the target app drops it.</summary>
    private static void Backup(string text)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pip");
            Directory.CreateDirectory(directory);
            var path = Path.Combine(directory, "dictation-backup.txt");
            var lines = File.Exists(path) ? File.ReadAllLines(path).TakeLast(200).ToList() : new List<string>();
            lines.Add($"{DateTime.Now:yyyy-MM-dd HH:mm:ss}\t{text.Replace('\n', ' ')}");
            File.WriteAllLines(path, lines);
        }
        catch
        {
            // best effort
        }
    }

    private async Task LearnFromCorrectionsAsync(string inserted)
    {
        await Task.Delay(TimeSpan.FromSeconds(20));
        var fieldText = UiaSnapshot.FocusedElementText();
        if (string.IsNullOrEmpty(fieldText)) return;
        var learned = DictionaryLearning.LearnCorrections(inserted, fieldText);
        if (learned.Count == 0) return;
        try
        {
            await backend.PostAsync("v2/dictation/dictionary", new { add = learned });
        }
        catch
        {
            // next time
        }
    }
}
