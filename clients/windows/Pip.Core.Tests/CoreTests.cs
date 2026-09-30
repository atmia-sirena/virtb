using Pip.Core;
using Xunit;

public class CoordinateTests
{
    // Two monitors: a 4K laptop panel at 150% on the left, a 1080p monitor at 100% to its right, offset down.
    private static readonly List<MonitorLayout> monitors = new()
    {
        new MonitorLayout(0, new PixelRect(0, 0, 3840, 2160), 1.5, true, 1280, 720),
        new MonitorLayout(1, new PixelRect(3840, 300, 1920, 1080), 1.0, false, 1280, 720),
    };

    [Fact]
    public void ScreenshotsKeepAspectAndCapTheLongEdge()
    {
        Assert.Equal((1280, 720), CoordinateMapper.ScreenshotSize(new PixelRect(0, 0, 3840, 2160)));
        Assert.Equal((720, 1280), CoordinateMapper.ScreenshotSize(new PixelRect(0, 0, 1080, 1920)));
        Assert.Equal((1024, 768), CoordinateMapper.ScreenshotSize(new PixelRect(0, 0, 1024, 768)));
    }

    [Fact]
    public void ImagePointsMapToTheRightMonitorAndDips()
    {
        var (x, y) = CoordinateMapper.ImageToScreen(monitors[1], 640, 360);
        Assert.Equal(3840 + 960, x, 3);
        Assert.Equal(300 + 540, y, 3);
        var (overlayX, overlayY) = CoordinateMapper.ScreenToOverlay(monitors[1], x, y);
        Assert.Equal(960, overlayX, 3);
        Assert.Equal(540, overlayY, 3);

        var (laptopX, laptopY) = CoordinateMapper.ImageToScreen(monitors[0], 640, 360);
        Assert.Equal(1920, laptopX, 3);
        var (laptopOverlayX, _) = CoordinateMapper.ScreenToOverlay(monitors[0], laptopX, laptopY);
        Assert.Equal(1280, laptopOverlayX, 3); // 1920 physical px / 1.5 = 1280 DIPs
    }

    [Fact]
    public void ElementRectsLandInTheirMonitorsImage()
    {
        var mapped = CoordinateMapper.ScreenRectToImage(monitors, new PixelRect(3840 + 192, 300 + 108, 192, 54))!.Value;
        Assert.Equal(1, mapped.Screen);
        Assert.Equal(new[] { 128, 72, 128, 36 }, mapped.Rect);
        Assert.Null(CoordinateMapper.ScreenRectToImage(monitors, new PixelRect(-5000, 0, 10, 10)));
    }
}

public class TextTests
{
    [Fact]
    public void TerminalsNeverGetNewlinesOrDashes()
    {
        Assert.True(TextRules.IsTerminalProcess("WindowsTerminal.exe"));
        Assert.False(TextRules.IsTerminalProcess("chrome"));
        Assert.Equal("git status, then git push", TextRules.PrepareForInsertion("git status —\ngit push".Replace("git push", "then git push"), true));
        Assert.Equal("line one\nline two", TextRules.PrepareForInsertion("line one\nline two", false));
    }

    [Fact]
    public void SpeechSplitsSentencesAndBreaksALongFirstOneAtAComma()
    {
        Assert.Equal(new[] { "hit export.", "then pick png." }, TextRules.SplitForSpeech("hit export. then pick png."));
        var chunks = TextRules.SplitForSpeech("okay so the thing you want is under the view menu, about halfway down the list.");
        Assert.Equal("okay so the thing you want is under the view menu,", chunks[0]);
        Assert.Equal(2, chunks.Count);
    }

    [Fact]
    public void LearnsCorrectedSpellings()
    {
        var learned = DictionaryLearning.LearnCorrections("ask cloudy about the launch", "ask Clicky about the launch");
        Assert.Equal(new[] { "Clicky" }, learned);
        Assert.Empty(DictionaryLearning.LearnCorrections("see you soon", "see you soon, thanks"));
    }
}

public class ShapeTests
{
    [Fact]
    public void RingOvershootsAndStaysNearItsRadius()
    {
        var ring = RoughShapes.Ring(100, 100, 40, 40, seed: 7);
        Assert.True(ring.Count > 50);
        Assert.All(ring, point => Assert.InRange(Math.Sqrt((point.X - 100) * (point.X - 100) + (point.Y - 100) * (point.Y - 100)), 34, 50));
        Assert.Equal(ring, RoughShapes.Ring(100, 100, 40, 40, seed: 7)); // deterministic
    }

    [Fact]
    public void ArrowEndsAtTheTarget()
    {
        var (shaft, left, right) = RoughShapes.Arrow(new RoughShapes.Point(0, 0), new RoughShapes.Point(200, 0), seed: 3);
        Assert.InRange(shaft[^1].X, 197, 203);
        Assert.Equal(new RoughShapes.Point(200, 0), left[^1]);
        Assert.Equal(new RoughShapes.Point(200, 0), right[^1]);
    }

    [Fact]
    public void FlightStartsAndEndsOnItsEndpoints()
    {
        var from = new RoughShapes.Point(10, 500);
        var to = new RoughShapes.Point(900, 80);
        Assert.Equal(from, RoughShapes.FlightPoint(from, to, 0));
        var end = RoughShapes.FlightPoint(from, to, 1);
        Assert.Equal(to.X, end.X, 6);
        Assert.Equal(to.Y, end.Y, 6);
    }
}

public class SseTests
{
    [Fact]
    public void ParsesEventsSplitAcrossChunks()
    {
        var parser = new SseParser();
        var messages = new List<SseMessage>();
        foreach (var chunk in new[] { "event: beat\nda", "ta: {\"text\":\"hi\"}\n", "\nevent: done\ndata: {}\n\n" }) messages.AddRange(parser.Push(chunk));
        Assert.Equal(new[] { new SseMessage("beat", "{\"text\":\"hi\"}"), new SseMessage("done", "{}") }, messages);
    }

    [Fact]
    public void DeserializesBeats()
    {
        var beat = System.Text.Json.JsonSerializer.Deserialize<BeatDto>("{\"text\":\"hit export\",\"visual\":{\"kind\":\"point\",\"screen\":1,\"points\":[[1220,35]],\"label\":\"export\"}}", PipJson.Options)!;
        Assert.Equal("point", beat.Visual!.Kind);
        Assert.Equal(1220, beat.Visual.Points[0][0]);
    }
}
