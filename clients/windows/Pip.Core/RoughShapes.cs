namespace Pip.Core;

/// <summary>
/// Hand-drawn (Excalidraw-style) geometry for the draw layer: slightly wobbly
/// rings that overshoot their start, arrows with a bowed shaft, and loose
/// polygons. Deterministic per seed so a shape doesn't shimmer between frames.
/// All coordinates are in the caller's space (overlay DIPs).
/// </summary>
public static class RoughShapes
{
    public readonly record struct Point(double X, double Y);

    private static double Noise(Random random, double amplitude) => (random.NextDouble() * 2 - 1) * amplitude;

    /// <summary>A ring around (cx, cy): 1.1 turns with a drifting radius, like a quick pen circle.</summary>
    public static List<Point> Ring(double centerX, double centerY, double radiusX, double radiusY, int seed, int segments = 56)
    {
        var random = new Random(seed);
        var points = new List<Point>(segments + 8);
        var startAngle = random.NextDouble() * Math.PI * 2;
        const double turns = 1.12;
        var wobble = Math.Max(1.5, Math.Min(radiusX, radiusY) * 0.06);
        for (var index = 0; index <= segments; index++)
        {
            var progress = (double)index / segments;
            var angle = startAngle + progress * turns * Math.PI * 2;
            // The radius drifts outward a little over the stroke so the overlap doesn't sit on top of the start.
            var drift = 1 + progress * 0.06;
            points.Add(new Point(centerX + Math.Cos(angle) * radiusX * drift + Noise(random, wobble), centerY + Math.Sin(angle) * radiusY * drift + Noise(random, wobble)));
        }
        return points;
    }

    /// <summary>An arrow from one point to another: a bowed shaft plus two head strokes.</summary>
    public static (List<Point> Shaft, List<Point> HeadLeft, List<Point> HeadRight) Arrow(Point from, Point to, int seed)
    {
        var random = new Random(seed);
        var dx = to.X - from.X;
        var dy = to.Y - from.Y;
        var length = Math.Max(1, Math.Sqrt(dx * dx + dy * dy));
        // Bow the shaft sideways by ~8% of its length.
        var normalX = -dy / length;
        var normalY = dx / length;
        var bow = length * 0.08 * (random.Next(2) == 0 ? 1 : -1);
        var control = new Point(from.X + dx / 2 + normalX * bow, from.Y + dy / 2 + normalY * bow);
        var shaft = new List<Point>();
        const int steps = 24;
        for (var index = 0; index <= steps; index++)
        {
            var t = (double)index / steps;
            var x = (1 - t) * (1 - t) * from.X + 2 * (1 - t) * t * control.X + t * t * to.X;
            var y = (1 - t) * (1 - t) * from.Y + 2 * (1 - t) * t * control.Y + t * t * to.Y;
            shaft.Add(new Point(x + Noise(random, 0.8), y + Noise(random, 0.8)));
        }
        // Head direction follows the curve's end tangent.
        var tangentX = to.X - control.X;
        var tangentY = to.Y - control.Y;
        var tangentLength = Math.Max(1, Math.Sqrt(tangentX * tangentX + tangentY * tangentY));
        tangentX /= tangentLength;
        tangentY /= tangentLength;
        var headLength = Math.Min(22, length * 0.3);
        List<Point> Head(double angle)
        {
            var cos = Math.Cos(angle);
            var sin = Math.Sin(angle);
            var backX = -(tangentX * cos - tangentY * sin);
            var backY = -(tangentX * sin + tangentY * cos);
            return new List<Point> { new(to.X + backX * headLength + Noise(random, 1), to.Y + backY * headLength + Noise(random, 1)), to };
        }
        return (shaft, Head(0.5), Head(-0.5));
    }

    /// <summary>A closed polygon through the points with loose corners (the last edge overshoots the start a bit).</summary>
    public static List<Point> Polygon(IReadOnlyList<Point> corners, int seed)
    {
        var random = new Random(seed);
        var points = new List<Point>();
        for (var index = 0; index <= corners.Count; index++)
        {
            var corner = corners[index % corners.Count];
            points.Add(new Point(corner.X + Noise(random, 2), corner.Y + Noise(random, 2)));
        }
        var first = corners[0];
        var second = corners[1 % corners.Count];
        points.Add(new Point(first.X + (second.X - first.X) * 0.12, first.Y + (second.Y - first.Y) * 0.12));
        return points;
    }

    /// <summary>A smooth path through several points (Catmull-Rom), for [SHAPE:curve].</summary>
    public static List<Point> Curve(IReadOnlyList<Point> through, int stepsPerSegment = 12)
    {
        if (through.Count < 2) return through.ToList();
        var points = new List<Point>();
        for (var segment = 0; segment < through.Count - 1; segment++)
        {
            var p0 = through[Math.Max(0, segment - 1)];
            var p1 = through[segment];
            var p2 = through[segment + 1];
            var p3 = through[Math.Min(through.Count - 1, segment + 2)];
            for (var step = 0; step < stepsPerSegment; step++)
            {
                var t = (double)step / stepsPerSegment;
                var t2 = t * t;
                var t3 = t2 * t;
                double Blend(double a, double b, double c, double d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
                points.Add(new Point(Blend(p0.X, p1.X, p2.X, p3.X), Blend(p0.Y, p1.Y, p2.Y, p3.Y)));
            }
        }
        points.Add(through[^1]);
        return points;
    }

    /// <summary>Point along the buddy's flight arc (quadratic bezier bowed upward), with ease-in-out.</summary>
    public static Point FlightPoint(Point from, Point to, double progress)
    {
        var eased = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.Pow(-2 * progress + 2, 3) / 2;
        var distance = Math.Sqrt((to.X - from.X) * (to.X - from.X) + (to.Y - from.Y) * (to.Y - from.Y));
        var control = new Point((from.X + to.X) / 2, Math.Min(from.Y, to.Y) - Math.Min(160, distance * 0.3));
        var inverse = 1 - eased;
        return new Point(
            inverse * inverse * from.X + 2 * inverse * eased * control.X + eased * eased * to.X,
            inverse * inverse * from.Y + 2 * inverse * eased * control.Y + eased * eased * to.Y);
    }
}
