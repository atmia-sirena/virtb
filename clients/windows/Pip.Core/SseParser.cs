using System.Text;

namespace Pip.Core;

public sealed record SseMessage(string Event, string Data);

/// <summary>Incremental Server-Sent Events parser (for /v2/chat and /events).</summary>
public sealed class SseParser
{
    private readonly StringBuilder pending = new();
    private string currentEvent = "message";
    private readonly StringBuilder currentData = new();

    public List<SseMessage> Push(string chunk)
    {
        var messages = new List<SseMessage>();
        pending.Append(chunk);
        while (true)
        {
            var text = pending.ToString();
            var newline = text.IndexOf('\n');
            if (newline < 0) break;
            var line = text[..newline].TrimEnd('\r');
            pending.Remove(0, newline + 1);
            if (line.Length == 0)
            {
                if (currentData.Length > 0) messages.Add(new SseMessage(currentEvent, currentData.ToString()));
                currentEvent = "message";
                currentData.Clear();
                continue;
            }
            if (line.StartsWith(':')) continue;
            var colon = line.IndexOf(':');
            var field = colon < 0 ? line : line[..colon];
            var value = colon < 0 ? "" : line[(colon + 1)..].TrimStart(' ');
            if (field == "event") currentEvent = value;
            else if (field == "data")
            {
                if (currentData.Length > 0) currentData.Append('\n');
                currentData.Append(value);
            }
        }
        return messages;
    }
}
