using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Threading;
using Pip.Audio;
using Pip.Backend;
using Pip.Core;
using Pip.Dictation;
using Pip.Input;
using Pip.Overlay;
using Pip.Platform;

namespace Pip.Talk;

/// <summary>
/// The push-to-talk loop. Key down: stop talking (barge-in), start the mic,
/// capture screens + UI tree and send them for vision prefetch. Key up: final
/// transcript, stream the turn from /v2/chat, speak each beat while the buddy
/// points and draws. Walkthroughs continue when the user clicks the target.
/// </summary>
public sealed class TalkController
{
    public event Action<string>? TextDelta;
    public event Action? TurnFinished;
    public event Action? SettingsChanged;

    private readonly BackendClient backend;
    private readonly OverlayManager overlay;
    private readonly Speaker speaker;
    private readonly Dispatcher dispatcher;
    private readonly ClickWatcher clickWatcher;

    private SpeechToText? speechToText;
    private Task<TurnContext>? captureTask;
    private CancellationTokenSource? turnCancellation;
    private string? talkingToAgentId;
    private bool listening;

    // Walkthrough state.
    private string? guideSessionId;
    private bool guideWaitingForClick;
    private (double X, double Y, double Radius)? guideTarget;
    private DateTime guideArmedAt;

    public TalkController(BackendClient backend, OverlayManager overlay, Speaker speaker, Dispatcher dispatcher)
    {
        this.backend = backend;
        this.overlay = overlay;
        this.speaker = speaker;
        this.dispatcher = dispatcher;
        clickWatcher = new ClickWatcher(dispatcher);
        clickWatcher.Clicked += OnClickWhileGuiding;
        speaker.ChunkStarted += OnBeatStarted;
        speaker.QueueDrained += () =>
        {
            if (streamFinished) FinishSpeaking();
        };
    }

    private bool streamFinished = true;
    private TurnContext? activeContext;

    // --- push to talk ---------------------------------------------------------------

    public async void BeginListening(string? agentId = null)
    {
        if (listening) return;
        listening = true;
        talkingToAgentId = agentId;
        speaker.Stop();
        turnCancellation?.Cancel();
        overlay.ClearDrawings();
        overlay.SetInteractionActive(true);
        overlay.SetState(BuddyState.Listening);
        overlay.SetCaption(null);
        var foreground = ForegroundApp.Read();
        speechToText = new SpeechToText(backend);
        speechToText.LevelChanged += level => dispatcher.BeginInvoke(() => overlay.SetLevel(level));
        speechToText.PartialTranscript += text => dispatcher.BeginInvoke(() =>
        {
            if (listening) overlay.SetCaption(text);
        });
        try
        {
            await speechToText.StartAsync();
        }
        catch (Exception error)
        {
            listening = false;
            ShowProblem($"i can't hear you: {error.Message}");
            return;
        }
        // Capture and prefetch vision in parallel with speech, so llava is already looking at the screen when the key comes up.
        captureTask = TurnContext.CaptureAsync(foreground);
        _ = captureTask.ContinueWith(async task =>
        {
            if (task.IsCompletedSuccessfully)
            {
                try
                {
                    await backend.PostAsync("v2/vision/prefetch", new { turnId = task.Result.TurnId, screens = task.Result.ScreenDtos() });
                }
                catch (Exception error)
                {
                    Trace.WriteLine($"[talk] prefetch failed: {error.Message}");
                }
            }
        }, TaskScheduler.Default);
    }

    public async void EndListening()
    {
        if (!listening || speechToText is null) return;
        listening = false;
        overlay.SetState(BuddyState.Thinking);
        string transcript;
        try
        {
            transcript = await speechToText.FinishAsync();
        }
        catch (Exception error)
        {
            ShowProblem($"speech-to-text failed: {error.Message}");
            return;
        }
        finally
        {
            speechToText.Dispose();
            speechToText = null;
        }
        if (string.IsNullOrWhiteSpace(transcript))
        {
            overlay.SetCaption("didn't catch that (・_・;)");
            overlay.SetState(BuddyState.Idle);
            FinishSpeaking();
            return;
        }
        overlay.SetCaption(transcript);
        TurnContext? context = null;
        try
        {
            if (captureTask is not null) context = await captureTask;
        }
        catch (Exception error)
        {
            // Answer without the screen rather than not at all.
            Trace.WriteLine($"[talk] capture failed: {error.Message}");
        }
        if (context?.Foreground.IsElevated == true)
        {
            speaker.Say("that window is running as admin, so i can't read it or type there. i'll go off the screenshot.");
        }
        var request = new TalkRequestDto
        {
            TurnId = context?.TurnId,
            Transcript = transcript,
            Mode = "voice",
            Elements = context?.Elements,
            Cursor = context?.Cursor,
            ActiveApp = context?.ActiveApp,
            SelectedText = context?.SelectedText,
            AgentId = talkingToAgentId,
        };
        await RunTurnAsync(request, context);
    }

    public void CancelListening()
    {
        if (!listening) return;
        listening = false;
        speechToText?.Cancel();
        speechToText = null;
        overlay.SetState(BuddyState.Idle);
        FinishSpeaking();
    }

    // --- typed turns (the text box) --------------------------------------------------------

    public async Task<TurnContext> CaptureForTextAsync() => await TurnContext.CaptureAsync(ForegroundApp.Read());

    public async Task SendTextAsync(string text, TurnContext context, string? documentText = null)
    {
        speaker.Stop();
        overlay.SetInteractionActive(true);
        overlay.SetState(BuddyState.Thinking);
        var request = new TalkRequestDto
        {
            TurnId = context.TurnId,
            Transcript = text,
            Mode = "text",
            Screens = context.ScreenDtos(),
            Elements = context.Elements,
            Cursor = context.Cursor,
            ActiveApp = context.ActiveApp,
            SelectedText = documentText ?? context.SelectedText,
        };
        await RunTurnAsync(request, context);
    }

    /// <summary>Speaks an announcement (agent done) unless the user is in a call, sharing, or in Focus.</summary>
    public void Announce(string text)
    {
        if (listening || QuietDetector.ShouldStayQuiet()) return;
        if (speaker.IsSpeaking) return;
        overlay.SetInteractionActive(true);
        overlay.SetCaption(text);
        overlay.SetState(BuddyState.Speaking);
        streamFinished = true;
        speaker.Say(text);
    }

    // --- the streamed turn ----------------------------------------------------------------

    private async Task RunTurnAsync(TalkRequestDto request, TurnContext? context)
    {
        turnCancellation?.Cancel();
        turnCancellation = new CancellationTokenSource();
        var token = turnCancellation.Token;
        activeContext = context;
        streamFinished = false;
        var spokeAnything = false;
        guideWaitingForClick = false;
        guideTarget = null;
        try
        {
            await foreach (var message in backend.StreamAsync("v2/chat", request, token))
            {
                switch (message.Event)
                {
                    case "beat":
                    {
                        var beat = JsonSerializer.Deserialize<BeatDto>(message.Data, PipJson.Options)!;
                        spokeAnything = true;
                        speaker.Say(beat.Text, beat);
                        break;
                    }
                    case "delta":
                        TextDelta?.Invoke(JsonDocument.Parse(message.Data).RootElement.GetProperty("text").GetString() ?? "");
                        break;
                    case "insert_text":
                    {
                        var text = JsonDocument.Parse(message.Data).RootElement.GetProperty("text").GetString() ?? "";
                        if (context is not null) await TextInserter.InsertAsync(context.Foreground.Window, context.Foreground.ProcessName, text);
                        break;
                    }
                    case "guide":
                    {
                        var guide = JsonSerializer.Deserialize<GuideEventDto>(message.Data, PipJson.Options)!;
                        guideSessionId = guide.Done ? null : guide.SessionId;
                        guideWaitingForClick = guide.WaitForClick && !guide.Done;
                        if (guideWaitingForClick)
                        {
                            guideArmedAt = DateTime.UtcNow;
                            clickWatcher.Start();
                        }
                        else
                        {
                            clickWatcher.Stop();
                        }
                        break;
                    }
                    case "settings":
                        SettingsChanged?.Invoke();
                        break;
                    case "error":
                    {
                        var errorText = JsonDocument.Parse(message.Data).RootElement.GetProperty("message").GetString();
                        speaker.Say("hmm, something broke on my end.");
                        Trace.WriteLine($"[talk] backend error: {errorText}");
                        spokeAnything = true;
                        break;
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (HttpRequestException error)
        {
            ShowProblem($"pip's backend isn't answering ({error.Message})");
            return;
        }
        streamFinished = true;
        if (!spokeAnything || !speaker.IsSpeaking) FinishSpeaking();
        TurnFinished?.Invoke();
    }

    private void OnBeatStarted(object? tag)
    {
        if (tag is not BeatDto beat) return;
        overlay.SetState(BuddyState.Speaking);
        overlay.SetCaption(beat.Text);
        if (beat.Visual is null || activeContext is null) return;
        var target = overlay.ApplyVisual(beat.Visual, activeContext.Layouts);
        if (target is not null && beat.Visual.Kind is "target" or "hover") guideTarget = target;
    }

    private void FinishSpeaking()
    {
        overlay.FinishInteraction(keepTarget: guideWaitingForClick);
        overlay.SetState(BuddyState.Idle);
        if (!guideWaitingForClick) overlay.SetInteractionActive(false);
    }

    // --- walkthroughs ---------------------------------------------------------------------------

    private async void OnClickWhileGuiding(int x, int y)
    {
        if (!guideWaitingForClick || guideSessionId is null) return;
        if ((DateTime.UtcNow - guideArmedAt).TotalMilliseconds < 400) return;
        if (guideTarget is { } target)
        {
            var distance = Math.Sqrt(Math.Pow(x - target.X, 2) + Math.Pow(y - target.Y, 2));
            if (distance > Math.Max(40, target.Radius * 1.5)) return;
        }
        guideWaitingForClick = false;
        clickWatcher.Stop();
        overlay.ClearDrawings();
        overlay.SetState(BuddyState.Thinking);
        // Let the app react to the click before looking again.
        await Task.Delay(700);
        var context = await TurnContext.CaptureAsync(ForegroundApp.Read());
        await RunTurnAsync(new TalkRequestDto
        {
            TurnId = context.TurnId,
            Transcript = "",
            Mode = "voice",
            Screens = context.ScreenDtos(),
            Elements = context.Elements,
            Cursor = context.Cursor,
            ActiveApp = context.ActiveApp,
            Guide = new GuideContinuationDto { SessionId = guideSessionId!, Event = "clicked" },
        }, context);
    }

    /// <summary>Esc during a walkthrough stops it.</summary>
    public void StopGuide()
    {
        if (guideSessionId is null && !speaker.IsSpeaking) return;
        speaker.Stop();
        clickWatcher.Stop();
        if (guideSessionId is { } sessionId)
        {
            _ = backend.StreamAsync("v2/chat", new TalkRequestDto { Transcript = "", Guide = new GuideContinuationDto { SessionId = sessionId, Event = "stop" } }).GetAsyncEnumerator().MoveNextAsync();
        }
        guideSessionId = null;
        guideWaitingForClick = false;
        overlay.ClearDrawings();
        overlay.ReturnToCursor();
        overlay.SetInteractionActive(false);
    }

    private void ShowProblem(string text)
    {
        overlay.SetState(BuddyState.Idle);
        overlay.SetCaption(text);
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            overlay.SetCaption(null);
            overlay.SetInteractionActive(false);
        };
        timer.Start();
    }
}
