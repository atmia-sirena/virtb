using System.Windows.Automation;
using Pip.Core;

namespace Pip.Capture;

/// <summary>
/// The foreground window's UI Automation tree, flattened to up to ~150
/// interactive or labeled elements with ids (e1, e2...) and rectangles in
/// screenshot pixels. The model points at these ids instead of guessing pixels
/// (HeyClicky reads the macOS accessibility tree the same way).
/// </summary>
public static class UiaSnapshot
{
    private static readonly HashSet<ControlType> interestingTypes = new()
    {
        ControlType.Button, ControlType.SplitButton, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox,
        ControlType.Edit, ControlType.Hyperlink, ControlType.MenuItem, ControlType.MenuBar, ControlType.Menu, ControlType.TabItem,
        ControlType.ListItem, ControlType.TreeItem, ControlType.Slider, ControlType.Spinner, ControlType.Document,
        ControlType.Text, ControlType.Image, ControlType.DataItem, ControlType.HeaderItem, ControlType.ToolBar, ControlType.Group,
    };

    public static List<ScreenElementDto> Capture(IntPtr foregroundWindow, IReadOnlyList<MonitorLayout> monitors, int maxElements = 150, int timeoutMilliseconds = 700)
    {
        // UIA calls can hang on misbehaving providers; run with a hard deadline.
        var task = Task.Run(() => Walk(foregroundWindow, monitors, maxElements));
        return task.Wait(timeoutMilliseconds) ? task.Result : new List<ScreenElementDto>();
    }

    private static List<ScreenElementDto> Walk(IntPtr foregroundWindow, IReadOnlyList<MonitorLayout> monitors, int maxElements)
    {
        var elements = new List<ScreenElementDto>();
        if (foregroundWindow == IntPtr.Zero) return elements;
        try
        {
            var cacheRequest = new CacheRequest { TreeScope = TreeScope.Element | TreeScope.Descendants, AutomationElementMode = AutomationElementMode.None };
            cacheRequest.Add(AutomationElement.NameProperty);
            cacheRequest.Add(AutomationElement.ControlTypeProperty);
            cacheRequest.Add(AutomationElement.BoundingRectangleProperty);
            cacheRequest.Add(AutomationElement.IsOffscreenProperty);
            cacheRequest.Add(AutomationElement.IsEnabledProperty);
            cacheRequest.Add(ValuePattern.ValueProperty);
            cacheRequest.TreeFilter = Automation.ControlViewCondition;
            AutomationElement root;
            using (cacheRequest.Activate())
            {
                root = AutomationElement.FromHandle(foregroundWindow);
                root = root.FindFirst(TreeScope.Element, Condition.TrueCondition) ?? root;
            }
            var queue = new Queue<AutomationElement>();
            queue.Enqueue(root);
            var visited = 0;
            // Breadth-first so top-level toolbars and menus make the cut before deep list items.
            while (queue.Count > 0 && elements.Count < maxElements && visited < 4000)
            {
                var element = queue.Dequeue();
                visited++;
                AutomationElementCollection children;
                try
                {
                    children = element.CachedChildren;
                }
                catch
                {
                    continue;
                }
                foreach (AutomationElement child in children) queue.Enqueue(child);
                var converted = Convert(element, monitors, elements.Count + 1);
                if (converted is not null) elements.Add(converted);
            }
        }
        catch (ElementNotAvailableException)
        {
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"[uia] {error.Message}");
        }
        return elements;
    }

    private static ScreenElementDto? Convert(AutomationElement element, IReadOnlyList<MonitorLayout> monitors, int number)
    {
        var controlType = element.Cached.ControlType;
        if (!interestingTypes.Contains(controlType)) return null;
        if (element.Cached.IsOffscreen) return null;
        var name = (element.Cached.Name ?? "").Trim();
        string? value = null;
        try
        {
            value = element.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
        }
        catch
        {
            // not supported
        }
        // Unlabeled containers and blank text help nobody.
        if (string.IsNullOrEmpty(name) && string.IsNullOrEmpty(value) && controlType != ControlType.Edit) return null;
        if ((controlType == ControlType.Group || controlType == ControlType.ToolBar || controlType == ControlType.Text) && name.Length > 120) name = name[..120];
        var bounds = element.Cached.BoundingRectangle;
        if (bounds.IsEmpty || bounds.Width < 3 || bounds.Height < 3) return null;
        var rect = new PixelRect((int)bounds.X, (int)bounds.Y, (int)bounds.Width, (int)bounds.Height);
        var mapped = CoordinateMapper.ScreenRectToImage(monitors, rect);
        if (mapped is null) return null;
        return new ScreenElementDto
        {
            Id = $"e{number}",
            Name = name,
            Role = controlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant(),
            Rect = mapped.Value.Rect,
            Screen = mapped.Value.Screen,
            Value = string.IsNullOrEmpty(value) ? null : value.Length > 80 ? value[..80] : value,
            Enabled = element.Cached.IsEnabled ? null : false,
        };
    }

    /// <summary>The browser's address bar value, when the foreground app is Chrome/Edge/Brave (for app skills by domain).</summary>
    public static string? BrowserUrl(IntPtr foregroundWindow)
    {
        var task = Task.Run(() =>
        {
            try
            {
                var root = AutomationElement.FromHandle(foregroundWindow);
                var edit = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
                if (edit?.GetCurrentPattern(ValuePattern.Pattern) is ValuePattern pattern)
                {
                    var text = pattern.Current.Value;
                    if (string.IsNullOrWhiteSpace(text)) return null;
                    return text.Contains("://") ? text : $"https://{text}";
                }
            }
            catch
            {
                // no address bar
            }
            return null;
        });
        return task.Wait(250) ? task.Result : null;
    }

    /// <summary>Text of the focused element, for dictionary learning after dictation.</summary>
    public static string? FocusedElementText()
    {
        var task = Task.Run(() =>
        {
            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern)) return ((ValuePattern)valuePattern).Current.Value;
                if (focused.TryGetCurrentPattern(TextPattern.Pattern, out var textPattern)) return ((TextPattern)textPattern).DocumentRange.GetText(8000);
            }
            catch
            {
                // focus moved or not readable
            }
            return null;
        });
        return task.Wait(300) ? task.Result : null;
    }

    /// <summary>The selected text in the focused element, sent with talk turns ("what does this mean?").</summary>
    public static string? SelectedText()
    {
        var task = Task.Run(() =>
        {
            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused.TryGetCurrentPattern(TextPattern.Pattern, out var textPattern))
                {
                    var selection = ((TextPattern)textPattern).GetSelection();
                    var text = string.Concat(selection.Select(range => range.GetText(4000)));
                    return string.IsNullOrWhiteSpace(text) ? null : text;
                }
            }
            catch
            {
                // not readable
            }
            return null;
        });
        return task.Wait(250) ? task.Result : null;
    }
}
