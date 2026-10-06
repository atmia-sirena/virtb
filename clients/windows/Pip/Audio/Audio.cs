using System.IO;
using System.Threading.Channels;
using System.Windows.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
using Pip.Backend;
using Pip.Core;

namespace Pip.Audio;

/// <summary>
/// Microphone capture for push-to-talk and dictation: WASAPI shared mode on the
/// default device (falls back to WaveIn, e.g. when the Bluetooth headset just
/// disconnected), converted to 16 kHz mono PCM16 in 250 ms chunks.
/// </summary>
public sealed class MicRecorder : IDisposable
{
    public const int SampleRate = 16000;
    public event Action<byte[]>? ChunkReady;
    public event Action<float>? LevelChanged;

    private IWaveIn? capture;
    private BufferedWaveProvider? buffered;
    private ISampleProvider? converter;
    private readonly List<byte> pending = new();
    private readonly object gate = new();
    private const int chunkBytes = SampleRate * 2 / 4;

    public void Start()
    {
        Stop();
        try
        {
            var device = new MMDeviceEnumerator().GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            capture = new WasapiCapture(device, true, 20);
        }
        catch
        {
            capture = new WaveInEvent { WaveFormat = new WaveFormat(SampleRate, 16, 1), BufferMilliseconds = 50 };
        }
        buffered = new BufferedWaveProvider(capture.WaveFormat) { DiscardOnBufferOverflow = true, ReadFully = false, BufferDuration = TimeSpan.FromSeconds(5) };
        var samples = buffered.ToSampleProvider();
        if (samples.WaveFormat.Channels == 2) samples = new StereoToMonoSampleProvider(samples);
        else if (samples.WaveFormat.Channels > 2) samples = new FirstChannelSampleProvider(samples);
        converter = samples.WaveFormat.SampleRate == SampleRate ? samples : new WdlResamplingSampleProvider(samples, SampleRate);
        capture.DataAvailable += OnData;
        capture.StartRecording();
    }

    private void OnData(object? sender, WaveInEventArgs args)
    {
        if (buffered is null || converter is null) return;
        buffered.AddSamples(args.Buffer, 0, args.BytesRecorded);
        var floats = new float[4096];
        double sumOfSquares = 0;
        var total = 0;
        lock (gate)
        {
            int read;
            while ((read = converter.Read(floats, 0, floats.Length)) > 0)
            {
                for (var index = 0; index < read; index++)
                {
                    var sample = Math.Clamp(floats[index], -1f, 1f);
                    sumOfSquares += sample * sample;
                    var value = (short)(sample * short.MaxValue);
                    pending.Add((byte)(value & 0xFF));
                    pending.Add((byte)((value >> 8) & 0xFF));
                }
                total += read;
            }
            while (pending.Count >= chunkBytes)
            {
                var chunk = pending.GetRange(0, chunkBytes).ToArray();
                pending.RemoveRange(0, chunkBytes);
                ChunkReady?.Invoke(chunk);
            }
        }
        if (total > 0) LevelChanged?.Invoke((float)Math.Min(1, Math.Sqrt(sumOfSquares / total) * 4));
    }

    /// <summary>Stops and flushes the last partial chunk.</summary>
    public void Stop()
    {
        if (capture is null) return;
        try
        {
            capture.DataAvailable -= OnData;
            capture.StopRecording();
        }
        catch
        {
            // device already gone
        }
        capture.Dispose();
        capture = null;
        lock (gate)
        {
            if (pending.Count > 0) ChunkReady?.Invoke(pending.ToArray());
            pending.Clear();
        }
    }

    public void Dispose() => Stop();

    private sealed class FirstChannelSampleProvider : ISampleProvider
    {
        private readonly ISampleProvider source;
        private float[] buffer = Array.Empty<float>();
        public FirstChannelSampleProvider(ISampleProvider source)
        {
            this.source = source;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
        }
        public WaveFormat WaveFormat { get; }
        public int Read(float[] output, int offset, int count)
        {
            var channels = source.WaveFormat.Channels;
            if (buffer.Length < count * channels) buffer = new float[count * channels];
            var read = source.Read(buffer, 0, count * channels);
            var frames = read / channels;
            for (var frame = 0; frame < frames; frame++) output[offset + frame] = buffer[frame * channels];
            return frames;
        }
    }
}

/// <summary>
/// One push-to-talk transcription (POST /v2/asr/sessions...). The backend runs it
/// on the GPU speech server (language ID, Indian languages) or Parakeet on the CPU.
/// </summary>
public sealed class SpeechToText : IDisposable
{
    public event Action<string>? PartialTranscript;
    /// <summary>The language the speech server detected (en, hi, hinglish, ta…), once known.</summary>
    public event Action<string>? LanguageDetected;
    private readonly BackendClient backend;
    private readonly MicRecorder recorder = new();
    private readonly Channel<byte[]> chunks = Channel.CreateUnbounded<byte[]>();
    private string? sessionId;
    private Task? pump;
    private string? detectedLanguage;

    /// <summary>The finished session, so cleanup can use its language and timed words.</summary>
    public string? LastSessionId { get; private set; }
    public string? Language { get; private set; }

    public event Action<float>? LevelChanged
    {
        add => recorder.LevelChanged += value;
        remove => recorder.LevelChanged -= value;
    }

    public SpeechToText(BackendClient backend)
    {
        this.backend = backend;
        recorder.ChunkReady += chunk => chunks.Writer.TryWrite(chunk);
    }

    /// <param name="options">Optional session options: { app, language, languages, context }.</param>
    public async Task StartAsync(object? options = null)
    {
        while (chunks.Reader.TryRead(out _)) { }
        detectedLanguage = null;
        // Start the mic before the session request returns so no words are lost.
        recorder.Start();
        var created = await backend.PostAsync<AsrSessionDto>("v2/asr/sessions", options ?? new { });
        sessionId = created?.SessionId;
        pump = Task.Run(PumpAsync);
    }

    private async Task PumpAsync()
    {
        await foreach (var chunk in chunks.Reader.ReadAllAsync())
        {
            if (sessionId is null) continue;
            if (chunk.Length == 0) break;
            try
            {
                var result = await backend.PostBytesAsync($"v2/asr/sessions/{sessionId}/audio", chunk);
                if (result.TryGetProperty("text", out var text) && text.GetString() is { Length: > 0 } partial) PartialTranscript?.Invoke(partial);
                if (result.TryGetProperty("language", out var language) && language.GetString() is { Length: > 0 } code && code != detectedLanguage)
                {
                    detectedLanguage = code;
                    LanguageDetected?.Invoke(code);
                }
            }
            catch
            {
                // a dropped chunk only costs interim text; the final decode uses everything received
            }
        }
    }

    /// <summary>Stops the mic and returns the final transcript.</summary>
    /// <param name="language">Overrides language ID (the user switched language while speaking).</param>
    public async Task<string> FinishAsync(string? language = null)
    {
        recorder.Stop();
        chunks.Writer.TryWrite(Array.Empty<byte>());
        if (pump is not null) await pump;
        if (sessionId is null) return "";
        var result = await backend.PostAsync<AsrSessionDto>($"v2/asr/sessions/{sessionId}/finish", language is null ? new { } : (object)new { language });
        LastSessionId = sessionId;
        Language = result?.Language;
        sessionId = null;
        return result?.Text?.Trim() ?? "";
    }

    public void Cancel()
    {
        recorder.Stop();
        chunks.Writer.TryWrite(Array.Empty<byte>());
        sessionId = null;
    }

    public void Dispose() => recorder.Dispose();

    private sealed class AsrSessionDto
    {
        public string? SessionId { get; set; }
        public string? Text { get; set; }
        public string? Language { get; set; }
    }
}

/// <summary>
/// Speaks beats one chunk at a time with the backend's local voice (Kokoro).
/// The next chunk is synthesized while the current one plays, and
/// <see cref="ChunkStarted"/> fires as each starts so the buddy can point and
/// draw in sync with the words (HeyClicky's tag-first beats).
/// </summary>
public sealed class Speaker : IDisposable
{
    public event Action<object?>? ChunkStarted;
    public event Action? QueueDrained;

    private readonly BackendClient backend;
    private readonly Dispatcher dispatcher;
    private Channel<SpeechItem> queue = Channel.CreateUnbounded<SpeechItem>();
    private CancellationTokenSource cancellation = new();
    private WaveOutEvent? output;
    private int pendingItems;

    private sealed record SpeechItem(Task<(byte[] Pcm, int SampleRate)> Audio, object? Tag);

    public Speaker(BackendClient backend, Dispatcher dispatcher)
    {
        this.backend = backend;
        this.dispatcher = dispatcher;
        _ = Task.Run(RunAsync);
    }

    public bool IsSpeaking => Volatile.Read(ref pendingItems) > 0;

    /// <summary>Queues text to say; <paramref name="tag"/> comes back in <see cref="ChunkStarted"/> for the first chunk.</summary>
    public void Say(string text, object? tag = null)
    {
        var chunks = TextRules.SplitForSpeech(text);
        if (chunks.Count == 0)
        {
            if (tag is not null) dispatcher.BeginInvoke(() => ChunkStarted?.Invoke(tag));
            return;
        }
        var token = cancellation.Token;
        for (var index = 0; index < chunks.Count; index++)
        {
            Interlocked.Increment(ref pendingItems);
            // Synthesis starts now (prefetch); playback waits its turn.
            var audio = backend.SynthesizeAsync(chunks[index], token);
            queue.Writer.TryWrite(new SpeechItem(audio, index == 0 ? tag : null));
        }
    }

    /// <summary>Barge-in: stop talking immediately and drop everything queued.</summary>
    public void Stop()
    {
        cancellation.Cancel();
        cancellation = new CancellationTokenSource();
        var oldQueue = queue;
        queue = Channel.CreateUnbounded<SpeechItem>();
        oldQueue.Writer.TryComplete();
        try
        {
            output?.Stop();
        }
        catch
        {
            // already stopped
        }
        Interlocked.Exchange(ref pendingItems, 0);
    }

    private async Task RunAsync()
    {
        while (true)
        {
            var currentQueue = queue;
            SpeechItem item;
            try
            {
                item = await currentQueue.Reader.ReadAsync();
            }
            catch (ChannelClosedException)
            {
                await Task.Delay(10);
                continue;
            }
            try
            {
                var (pcm, sampleRate) = await item.Audio;
                if (currentQueue != queue) continue; // stopped while synthesizing
                if (item.Tag is not null) await dispatcher.InvokeAsync(() => ChunkStarted?.Invoke(item.Tag));
                if (pcm.Length > 0) await PlayAsync(pcm, sampleRate, cancellation.Token);
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception error)
            {
                System.Diagnostics.Trace.WriteLine($"[speaker] {error.Message}");
                if (item.Tag is not null) await dispatcher.InvokeAsync(() => ChunkStarted?.Invoke(item.Tag));
            }
            finally
            {
                if (Interlocked.Decrement(ref pendingItems) <= 0)
                {
                    Interlocked.Exchange(ref pendingItems, 0);
                    await dispatcher.InvokeAsync(() => QueueDrained?.Invoke());
                }
            }
        }
    }

    private async Task PlayAsync(byte[] pcm, int sampleRate, CancellationToken token)
    {
        var finished = new TaskCompletionSource();
        using var stream = new RawSourceWaveStream(new MemoryStream(pcm), new WaveFormat(sampleRate, 16, 1));
        using var player = new WaveOutEvent { DesiredLatency = 120 };
        output = player;
        player.PlaybackStopped += (_, _) => finished.TrySetResult();
        player.Init(stream);
        player.Play();
        using (token.Register(() => { try { player.Stop(); } catch { } finished.TrySetResult(); }))
        {
            await finished.Task;
        }
        output = null;
    }

    public void Dispose() => Stop();
}
