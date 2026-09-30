using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Pip.Core;
using static Pip.Native.NativeMethods;

namespace Pip.Backend;

/// <summary>HTTP client for the local backend on 127.0.0.1:8787.</summary>
public sealed class BackendClient : IDisposable
{
    public Uri BaseUri { get; }
    private readonly HttpClient http;

    public BackendClient(string baseUrl)
    {
        BaseUri = new Uri(baseUrl.TrimEnd('/') + "/");
        http = new HttpClient(new SocketsHttpHandler { PooledConnectionIdleTimeout = TimeSpan.FromMinutes(5), UseProxy = false }) { BaseAddress = BaseUri, Timeout = Timeout.InfiniteTimeSpan };
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellation = default)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            var response = await http.GetAsync("health", timeout.Token);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<T?> GetAsync<T>(string path, CancellationToken cancellation = default) =>
        await http.GetFromJsonAsync<T>(path, PipJson.Options, cancellation);

    public async Task<T?> PostAsync<T>(string path, object? body, CancellationToken cancellation = default)
    {
        using var response = await http.PostAsJsonAsync(path, body ?? new { }, PipJson.Options, cancellation);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<T>(PipJson.Options, cancellation);
    }

    public async Task PostAsync(string path, object? body, CancellationToken cancellation = default)
    {
        using var response = await http.PostAsJsonAsync(path, body ?? new { }, PipJson.Options, cancellation);
        response.EnsureSuccessStatusCode();
    }

    public async Task<JsonElement> PostBytesAsync(string path, byte[] bytes, CancellationToken cancellation = default)
    {
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
        using var response = await http.PostAsync(path, content, cancellation);
        var text = await response.Content.ReadAsStringAsync(cancellation);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"{path}: {response.StatusCode} {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    /// <summary>Local speech: returns raw PCM16 mono audio and its sample rate.</summary>
    public async Task<(byte[] Pcm, int SampleRate)> SynthesizeAsync(string text, CancellationToken cancellation)
    {
        using var response = await http.PostAsJsonAsync("tts", new { text }, PipJson.Options, cancellation);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"tts: {response.StatusCode} {await response.Content.ReadAsStringAsync(cancellation)}");
        var sampleRate = response.Headers.TryGetValues("x-sample-rate", out var values) && int.TryParse(values.FirstOrDefault(), out var rate) ? rate : 24000;
        return (await response.Content.ReadAsByteArrayAsync(cancellation), sampleRate);
    }

    /// <summary>POSTs JSON and yields Server-Sent Events as they arrive.</summary>
    public async IAsyncEnumerable<SseMessage> StreamAsync(string path, object body, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body, options: PipJson.Options) };
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        response.EnsureSuccessStatusCode();
        await foreach (var message in ReadSse(response, cancellation)) yield return message;
    }

    /// <summary>GET /events forever (reconnecting), for agent cards, announcements and notifications.</summary>
    public async IAsyncEnumerable<PipEventDto> EventsAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation = default)
    {
        while (!cancellation.IsCancellationRequested)
        {
            HttpResponseMessage? response = null;
            try
            {
                response = await http.GetAsync("events", HttpCompletionOption.ResponseHeadersRead, cancellation);
            }
            catch when (!cancellation.IsCancellationRequested)
            {
            }
            if (response is { IsSuccessStatusCode: true })
            {
                var enumerator = ReadSse(response, cancellation).GetAsyncEnumerator(cancellation);
                while (true)
                {
                    SseMessage message;
                    try
                    {
                        if (!await enumerator.MoveNextAsync()) break;
                        message = enumerator.Current;
                    }
                    catch when (!cancellation.IsCancellationRequested)
                    {
                        break;
                    }
                    if (message.Event == "ping") continue;
                    PipEventDto? parsed = null;
                    try
                    {
                        parsed = JsonSerializer.Deserialize<PipEventDto>(message.Data, PipJson.Options);
                    }
                    catch (JsonException)
                    {
                    }
                    if (parsed is not null) yield return parsed;
                }
            }
            response?.Dispose();
            await Task.Delay(2000, cancellation).ContinueWith(_ => { });
        }
    }

    private static async IAsyncEnumerable<SseMessage> ReadSse(HttpResponseMessage response, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        var parser = new SseParser();
        var buffer = new byte[8192];
        var decoder = Encoding.UTF8.GetDecoder();
        var characters = new char[8192];
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellation);
            if (read == 0) yield break;
            var count = decoder.GetChars(buffer, 0, read, characters, 0);
            foreach (var message in parser.Push(new string(characters, 0, count))) yield return message;
        }
    }

    public void Dispose() => http.Dispose();
}

/// <summary>
/// Starts the Node backend when it isn't already running, inside a Job Object
/// so it's killed when Pip exits ("close the app and it's closed").
/// </summary>
public sealed class BackendProcess : IDisposable
{
    private Process? process;
    private IntPtr job;

    public static string? FindRepositoryRoot()
    {
        var fromEnvironment = Environment.GetEnvironmentVariable("PIP_REPO_ROOT");
        if (!string.IsNullOrEmpty(fromEnvironment) && File.Exists(Path.Combine(fromEnvironment, "backend", "package.json"))) return fromEnvironment;
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "backend", "package.json"))) return directory.FullName;
            directory = directory.Parent;
        }
        return null;
    }

    public async Task<bool> EnsureRunningAsync(BackendClient client, Action<string> log)
    {
        if (await client.IsHealthyAsync()) return true;
        var root = FindRepositoryRoot();
        if (root is null)
        {
            log("couldn't find the repo (set PIP_REPO_ROOT). start the backend yourself: npm start --prefix backend");
            return false;
        }
        var backendDirectory = Path.Combine(root, "backend");
        var entry = Path.Combine(backendDirectory, "dist", "index.js");
        if (!File.Exists(entry))
        {
            log("backend isn't built. run scripts\\setup.ps1 (or: npm run build --prefix backend)");
            return false;
        }
        var startInfo = new ProcessStartInfo("node", $"\"{entry}\"")
        {
            WorkingDirectory = backendDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        process = Process.Start(startInfo);
        if (process is null) return false;
        process.OutputDataReceived += (_, line) => { if (line.Data is not null) log(line.Data); };
        process.ErrorDataReceived += (_, line) => { if (line.Data is not null) log(line.Data); };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        AttachToKillOnCloseJob(process);
        for (var attempt = 0; attempt < 60; attempt++)
        {
            if (await client.IsHealthyAsync()) return true;
            if (process.HasExited) return false;
            await Task.Delay(250);
        }
        return false;
    }

    private void AttachToKillOnCloseJob(Process child)
    {
        job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
        AssignProcessToJobObject(job, child.Handle);
    }

    public void Dispose()
    {
        try
        {
            if (process is { HasExited: false }) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // already gone
        }
        if (job != IntPtr.Zero) CloseHandle(job);
    }
}
