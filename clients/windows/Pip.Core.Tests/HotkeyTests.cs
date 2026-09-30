using Pip.Core;
using Xunit;

public class HotkeyTests
{
    private static readonly DateTime start = new(2026, 9, 30, 12, 0, 0);
    private static DateTime At(int milliseconds) => start.AddMilliseconds(milliseconds);

    private static HotkeyStateMachine Machine()
    {
        var machine = new HotkeyStateMachine();
        machine.SetChord("talk", HotkeyChord.Parse("Ctrl+Win (hold)"));
        machine.SetChord("dictate", HotkeyChord.Parse("RightCtrl (hold)"));
        machine.SetChord("text", HotkeyChord.Parse("LeftCtrl (double-tap)"));
        machine.SetChord("hands-free", HotkeyChord.Parse("RightCtrl (double-tap)"));
        return machine;
    }

    [Fact]
    public void ParsesSettingsFormat()
    {
        var chord = HotkeyChord.Parse("Ctrl+Win (hold)");
        Assert.Equal(new[] { HotkeyKey.Ctrl, HotkeyKey.Win }, chord.Keys);
        Assert.Equal(HotkeyMode.Hold, chord.Mode);
        Assert.Equal(HotkeyMode.DoubleTap, HotkeyChord.Parse("Ctrl (double-tap)").Mode);
        Assert.Throws<FormatException>(() => HotkeyChord.Parse("Ctrl+Banana (hold)"));
    }

    [Fact]
    public void CtrlWinHoldStartsAfterDelayAndEndsOnRelease()
    {
        var machine = Machine();
        machine.OnKey(HotkeyKey.LeftCtrl, true, At(0));
        Assert.Empty(machine.OnKey(HotkeyKey.Win, true, At(20)).Where(signal => signal.Name == "talk"));
        var started = machine.Tick(At(250));
        Assert.Contains(new HotkeySignal("talk", HotkeyAction.HoldStarted), started);
        var ended = machine.OnKey(HotkeyKey.Win, false, At(1500));
        Assert.Contains(new HotkeySignal("talk", HotkeyAction.HoldEnded), ended);
    }

    [Fact]
    public void WinDShortcutDoesNotTriggerTalk()
    {
        var machine = Machine();
        machine.OnKey(HotkeyKey.LeftCtrl, true, At(0));
        machine.OnKey(HotkeyKey.Win, true, At(20));
        machine.OnKey(HotkeyKey.Other, true, At(60)); // Ctrl+Win+D (new virtual desktop)
        Assert.DoesNotContain(machine.Tick(At(400)), signal => signal.Action == HotkeyAction.HoldStarted);
    }

    [Fact]
    public void RightCtrlHoldDictatesButCtrlCDoesNot()
    {
        var machine = Machine();
        machine.OnKey(HotkeyKey.RightCtrl, true, At(0));
        Assert.Contains(new HotkeySignal("dictate", HotkeyAction.HoldStarted), machine.Tick(At(240)));
        Assert.Contains(new HotkeySignal("dictate", HotkeyAction.HoldEnded), machine.OnKey(HotkeyKey.RightCtrl, false, At(900)));

        var copy = Machine();
        copy.OnKey(HotkeyKey.RightCtrl, true, At(0));
        copy.OnKey(HotkeyKey.Other, true, At(50));
        Assert.Empty(copy.Tick(At(400)));
    }

    [Fact]
    public void DoubleTapCtrlOpensTextBoxButSlowTapsDoNot()
    {
        var machine = Machine();
        machine.OnKey(HotkeyKey.LeftCtrl, true, At(0));
        machine.OnKey(HotkeyKey.LeftCtrl, false, At(80));
        machine.OnKey(HotkeyKey.LeftCtrl, true, At(200));
        Assert.Contains(new HotkeySignal("text", HotkeyAction.DoubleTapped), machine.OnKey(HotkeyKey.LeftCtrl, false, At(270)));

        var slow = Machine();
        slow.OnKey(HotkeyKey.LeftCtrl, true, At(0));
        slow.OnKey(HotkeyKey.LeftCtrl, false, At(80));
        slow.OnKey(HotkeyKey.LeftCtrl, true, At(900));
        Assert.DoesNotContain(slow.OnKey(HotkeyKey.LeftCtrl, false, At(960)), signal => signal.Action == HotkeyAction.DoubleTapped);
    }

    [Fact]
    public void KeyRepeatDoesNotRestartAHold()
    {
        var machine = Machine();
        machine.OnKey(HotkeyKey.RightCtrl, true, At(0));
        machine.Tick(At(240));
        for (var time = 260; time < 800; time += 30) Assert.Empty(machine.OnKey(HotkeyKey.RightCtrl, true, At(time)));
        Assert.True(machine.IsHoldActive("dictate"));
    }
}

public class HandsFreeTests
{
    [Fact]
    public void DoubleTappingRightCtrlStartsHandsFreeButNotTheTextBoxOrAHold()
    {
        var start = new DateTime(2026, 9, 30);
        var machine = new HotkeyStateMachine();
        machine.SetChord("dictate", HotkeyChord.Parse("RightCtrl (hold)"));
        machine.SetChord("text", HotkeyChord.Parse("LeftCtrl (double-tap)"));
        machine.SetChord("hands-free", HotkeyChord.Parse("RightCtrl (double-tap)"));
        var signals = new List<HotkeySignal>();
        signals.AddRange(machine.OnKey(HotkeyKey.RightCtrl, true, start));
        signals.AddRange(machine.Tick(start.AddMilliseconds(150)));
        signals.AddRange(machine.OnKey(HotkeyKey.RightCtrl, false, start.AddMilliseconds(160)));
        signals.AddRange(machine.OnKey(HotkeyKey.RightCtrl, true, start.AddMilliseconds(300)));
        signals.AddRange(machine.OnKey(HotkeyKey.RightCtrl, false, start.AddMilliseconds(420)));
        Assert.Equal(new[] { new HotkeySignal("hands-free", HotkeyAction.DoubleTapped) }, signals);
    }
}
