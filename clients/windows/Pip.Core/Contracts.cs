using System.Text.Json;
using System.Text.Json.Serialization;

namespace Pip.Core;

// Wire types shared with the backend (backend/src/talk/*.ts). JSON is camelCase.

public static class PipJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed class ScreenCaptureDto
{
    public int Index { get; set; }
    public string? Label { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    /// <summary>Base64 JPEG, no data: prefix.</summary>
    public string Image { get; set; } = "";
    public bool IsCursorScreen { get; set; }
    public PointDto? Cursor { get; set; }
}

public sealed class PointDto
{
    public double X { get; set; }
    public double Y { get; set; }
}

public sealed class ScreenElementDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Role { get; set; } = "";
    /// <summary>[x, y, width, height] in screenshot pixels.</summary>
    public int[] Rect { get; set; } = new int[4];
    public int Screen { get; set; }
    public string? Value { get; set; }
    public bool? Enabled { get; set; }
}

public sealed class CursorDto
{
    public int Screen { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
}

public sealed class ActiveAppDto
{
    public string? Name { get; set; }
    public string? Process { get; set; }
    public string? Title { get; set; }
    public string? Url { get; set; }
}

public sealed class GuideContinuationDto
{
    public string SessionId { get; set; } = "";
    /// <summary>clicked | continue | skip | stop</summary>
    public string Event { get; set; } = "clicked";
}

public sealed class TalkRequestDto
{
    public string? TurnId { get; set; }
    public string Transcript { get; set; } = "";
    public string Mode { get; set; } = "voice";
    public List<ScreenCaptureDto>? Screens { get; set; }
    public List<ScreenElementDto>? Elements { get; set; }
    public CursorDto? Cursor { get; set; }
    public ActiveAppDto? ActiveApp { get; set; }
    public string? SelectedText { get; set; }
    public string? AgentId { get; set; }
    public GuideContinuationDto? Guide { get; set; }
}

public sealed class VisualDto
{
    /// <summary>point | target | hover | highlight | circle | arrow | curve | polygon | open | done</summary>
    public string Kind { get; set; } = "";
    public int Screen { get; set; }
    public List<double[]> Points { get; set; } = new();
    public double? Radius { get; set; }
    public double[]? Rect { get; set; }
    public string? Label { get; set; }
    public string? Url { get; set; }
    public string? ElementId { get; set; }
}

public sealed class BeatDto
{
    public string Text { get; set; } = "";
    public VisualDto? Visual { get; set; }
}

public sealed class GuideEventDto
{
    public string SessionId { get; set; } = "";
    public int Step { get; set; }
    public int MaxSteps { get; set; }
    public string Goal { get; set; } = "";
    public bool Done { get; set; }
    public bool WaitForClick { get; set; }
}

public sealed class AgentLaunchDto
{
    public string AgentId { get; set; } = "";
    public string AgentName { get; set; } = "";
    public string RunId { get; set; } = "";
    public int CancelWindowSeconds { get; set; }
}

public sealed class RouteDto
{
    public string Route { get; set; } = "";
    public string? Model { get; set; }
}

public sealed class ClientSettingsDto
{
    public ShortcutsDto Shortcuts { get; set; } = new();
    public CursorSettingsDto Cursor { get; set; } = new();
    public VoiceSettingsDto Voice { get; set; } = new();
    public OnboardingDto Onboarding { get; set; } = new();
    public AgentSettingsDto Agents { get; set; } = new();
}

public sealed class ShortcutsDto
{
    public string Talk { get; set; } = "Ctrl+Win (hold)";
    public string Dictate { get; set; } = "RightCtrl (hold)";
    public string TextMode { get; set; } = "LeftCtrl (double-tap)";
}

public sealed class CursorSettingsDto
{
    public string Color { get; set; } = "#3380FF";
    public bool FollowCursor { get; set; } = true;
    public bool ShowBuddy { get; set; } = true;
}

public sealed class VoiceSettingsDto
{
    public string VoiceName { get; set; } = "af_heart";
    public double Speed { get; set; } = 1;
}

public sealed class OnboardingDto
{
    public bool Completed { get; set; }
}

public sealed class AgentSettingsDto
{
    public bool AnnounceWhenDone { get; set; } = true;
}

/// <summary>Agent and run shapes carried by GET /events.</summary>
public sealed class AgentDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Face { get; set; } = "";
    public string Status { get; set; } = "idle";
    public int Unread { get; set; }
    public bool Pinned { get; set; }
    public string? LastMessage { get; set; }
}

public sealed class PermissionDto
{
    public string Id { get; set; } = "";
    public string Tool { get; set; } = "";
    public string Summary { get; set; } = "";
    public string Risk { get; set; } = "write";
}

public sealed class RunStepDto
{
    public string Text { get; set; } = "";
    public string Kind { get; set; } = "";
}

public sealed class RunDto
{
    public string Id { get; set; } = "";
    public string AgentId { get; set; } = "";
    public string Prompt { get; set; } = "";
    public string Status { get; set; } = "";
    public List<RunStepDto> Steps { get; set; } = new();
    public List<string> Files { get; set; } = new();
    public string? Summary { get; set; }
    public string? Error { get; set; }
    public PermissionDto? Permission { get; set; }
    public string StartsAt { get; set; } = "";
}

public sealed class PipEventDataDto
{
    public RunDto? Run { get; set; }
    public AgentDto? Agent { get; set; }
    public PermissionDto? Permission { get; set; }
    public string? Text { get; set; }
    public string? AgentId { get; set; }
    public int? CancelWindowSeconds { get; set; }
}

public sealed class PipEventDto
{
    public string Type { get; set; } = "";
    public string At { get; set; } = "";
    public PipEventDataDto Data { get; set; } = new();
}
