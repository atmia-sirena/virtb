// Spatial tag grammar. HeyClicky answers in "tag-first beat lines": each line
// starts with at most one visual tag and then the sentence spoken while that
// visual shows. We keep their tags and add an element-id form (#e12) so small
// local models can point at a real UI Automation element instead of guessing
// pixels; the server resolves ids to coordinates before the client sees them.
//
//   [POINT:x,y:label:screenN]         [POINT:#e12:label]      [POINT:none]
//   [TARGET:x,y,r:label]              [TARGET:#e12:label]     (a click Pip waits for)
//   [HOVER:x,y,r:label]               [HOVER:#e12:label]
//   [HIGHLIGHT:x1,y1,x2,y2:label]     [HIGHLIGHT:#e12:label]
//   [SHAPE:circle:cx,cy;ex,ey:label]  [SHAPE:circle:#e12:label]
//   [SHAPE:arrow:x1,y1;x2,y2:label]   [SHAPE:arrow:#e3>#e12:label]
//   [SHAPE:curve:x1,y1;x2,y2;x3,y3:label]
//   [SHAPE:polygon:x1,y1;x2,y2;x3,y3...:label]
//   [OPEN:https://...]                [DONE]
// Numeric coordinates are pixels of the screenshot sent for that screen.

export type VisualKind =
  | "point"
  | "target"
  | "hover"
  | "highlight"
  | "circle"
  | "arrow"
  | "curve"
  | "polygon"
  | "open"
  | "done";

export interface ScreenElement {
  /** "e12" — assigned by the client, unique within one turn. */
  id: string;
  name: string;
  role: string;
  /** [x, y, width, height] in screenshot pixels of `screen`. */
  rect: [number, number, number, number];
  screen: number;
  value?: string;
  enabled?: boolean;
}

export interface Visual {
  kind: VisualKind;
  screen: number;
  /** Points in screenshot pixels. point/target/hover: [center]; circle: [center, edge]; arrow: [from, to]. */
  points: [number, number][];
  radius?: number;
  rect?: [number, number, number, number];
  label?: string;
  url?: string;
  elementId?: string;
}

export interface Beat {
  text: string;
  visual?: Visual;
  /** Set when a tag referenced something we couldn't resolve (e.g. unknown element id). */
  unresolved?: { tag: string; label?: string; screen: number };
}

const tagPattern = /\[(POINT|TARGET|HOVER|HIGHLIGHT|SHAPE|OPEN|DONE)(?::([^\]]*))?\]/gi;

function parseNumberList(text: string): number[] | undefined {
  const parts = text.split(",").map((part) => Number(part.trim()));
  return parts.every((value) => Number.isFinite(value)) ? parts : undefined;
}

function parseScreenSuffix(segments: string[], defaultScreen: number): { screen: number; rest: string[] } {
  const last = segments[segments.length - 1];
  const match = last?.trim().match(/^screen\s*(\d+)$/i);
  if (match) return { screen: Number(match[1]), rest: segments.slice(0, -1) };
  return { screen: defaultScreen, rest: segments };
}

function elementIdFrom(text: string): string | undefined {
  const match = text.trim().match(/^#?(e\d+)$/i);
  return match ? match[1].toLowerCase() : undefined;
}

function center(rect: [number, number, number, number]): [number, number] {
  return [Math.round(rect[0] + rect[2] / 2), Math.round(rect[1] + rect[3] / 2)];
}

function radiusFor(rect: [number, number, number, number]): number {
  return Math.max(14, Math.round(Math.hypot(rect[2], rect[3]) / 2) + 6);
}

export interface ResolveContext {
  elements: Map<string, ScreenElement>;
  /** Screen the cursor is on, used when a tag omits :screenN. */
  defaultScreen: number;
}

export function buildResolveContext(elements: ScreenElement[], defaultScreen: number): ResolveContext {
  return { elements: new Map(elements.map((element) => [element.id.toLowerCase(), element])), defaultScreen };
}

interface ParsedTag {
  raw: string;
  visual?: Visual;
  unresolved?: Beat["unresolved"];
  none?: boolean;
}

function parseTag(name: string, body: string | undefined, context: ResolveContext): ParsedTag {
  const upperName = name.toUpperCase();
  const raw = `[${upperName}${body !== undefined ? `:${body}` : ""}]`;
  if (upperName === "DONE") return { raw, visual: { kind: "done", screen: context.defaultScreen, points: [] } };
  if (upperName === "OPEN") {
    const url = (body ?? "").trim();
    return /^https?:\/\//i.test(url) ? { raw, visual: { kind: "open", screen: context.defaultScreen, points: [], url } } : { raw };
  }
  if (body === undefined || body.trim() === "") return { raw };
  if (body.trim().toLowerCase() === "none") return { raw, none: true };

  if (upperName === "SHAPE") {
    const [shapeName, ...shapeRest] = body.split(":");
    return parseShape(raw, shapeName.trim().toLowerCase(), shapeRest, context);
  }

  const segments = body.split(":");
  const { screen, rest } = parseScreenSuffix(segments, context.defaultScreen);
  const [locator, ...labelParts] = rest;
  const label = labelParts.join(":").trim() || undefined;
  const kind = upperName.toLowerCase() as VisualKind;

  const elementId = elementIdFrom(locator);
  if (elementId) {
    const element = context.elements.get(elementId);
    if (!element) return { raw, unresolved: { tag: upperName, label, screen } };
    const visual: Visual = { kind, screen: element.screen, points: [center(element.rect)], label: label ?? element.name, elementId };
    if (kind === "highlight") visual.rect = element.rect;
    if (kind === "target" || kind === "hover") visual.radius = radiusFor(element.rect);
    return { raw, visual };
  }

  const numbers = parseNumberList(locator);
  if (!numbers) return { raw, unresolved: { tag: upperName, label: label ?? locator.trim(), screen } };
  if (kind === "highlight") {
    if (numbers.length !== 4) return { raw };
    const [x1, y1, x2, y2] = numbers;
    const rect: [number, number, number, number] = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
    return { raw, visual: { kind, screen, points: [center(rect)], rect, label } };
  }
  if (numbers.length < 2) return { raw };
  const visual: Visual = { kind, screen, points: [[numbers[0], numbers[1]]], label };
  if (kind === "target" || kind === "hover") visual.radius = numbers[2] ?? 36;
  return { raw, visual };
}

function parsePointList(text: string): [number, number][] | undefined {
  const points: [number, number][] = [];
  for (const pair of text.split(";")) {
    const numbers = parseNumberList(pair);
    if (!numbers || numbers.length !== 2) return undefined;
    points.push([numbers[0], numbers[1]]);
  }
  return points;
}

function parseShape(raw: string, shapeName: string, segments: string[], context: ResolveContext): ParsedTag {
  const { screen, rest } = parseScreenSuffix(segments, context.defaultScreen);
  const [locator = "", ...labelParts] = rest;
  const label = labelParts.join(":").trim() || undefined;
  const kind: VisualKind | undefined =
    shapeName === "circle" || shapeName === "ring" ? "circle"
      : shapeName === "arrow" ? "arrow"
        : shapeName === "curve" ? "curve"
          : shapeName === "polygon" ? "polygon"
            : undefined;
  if (!kind) return { raw };

  // Element forms: [SHAPE:circle:#e12:label], [SHAPE:arrow:#e3>#e12:label]
  const elementIds = locator.split(">").map((part) => elementIdFrom(part));
  if (elementIds.every((id) => id !== undefined) && elementIds.length > 0) {
    const elements = elementIds.map((id) => context.elements.get(id!));
    if (elements.some((element) => !element)) return { raw, unresolved: { tag: `SHAPE:${shapeName}`, label, screen } };
    const resolved = elements as ScreenElement[];
    if (kind === "circle") {
      const element = resolved[0];
      const [cx, cy] = center(element.rect);
      return { raw, visual: { kind, screen: element.screen, points: [[cx, cy], [cx + radiusFor(element.rect), cy]], radius: radiusFor(element.rect), label: label ?? element.name, elementId: element.id } };
    }
    if (kind === "arrow" && resolved.length >= 2) {
      return { raw, visual: { kind, screen: resolved[1].screen, points: [center(resolved[0].rect), center(resolved[1].rect)], label } };
    }
    if (kind === "arrow" && resolved.length === 1) {
      // Arrow pointing at one element from up-left.
      const [x, y] = center(resolved[0].rect);
      return { raw, visual: { kind, screen: resolved[0].screen, points: [[x - 120, y - 90], [x - 8, y - 6]], label } };
    }
    return { raw };
  }

  const points = parsePointList(locator);
  if (!points) return { raw, unresolved: { tag: `SHAPE:${shapeName}`, label: label ?? locator.trim(), screen } };
  if (kind === "circle") {
    if (points.length !== 2) return { raw };
    const radius = Math.round(Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]));
    return { raw, visual: { kind, screen, points, radius, label } };
  }
  if (kind === "arrow" && points.length !== 2) return { raw };
  if (kind === "curve" && points.length < 2) return { raw };
  if (kind === "polygon" && points.length < 3) return { raw };
  return { raw, visual: { kind, screen, points, label } };
}

/** Parses one beat line. Tags anywhere in the line are removed from the spoken text; the first visual wins. */
export function parseBeatLine(line: string, context: ResolveContext): Beat {
  let visual: Visual | undefined;
  let unresolved: Beat["unresolved"];
  const text = line
    .replace(tagPattern, (_match, name: string, body: string | undefined) => {
      const parsed = parseTag(name, body, context);
      if (!visual && parsed.visual) visual = parsed.visual;
      if (!visual && !unresolved && parsed.unresolved) unresolved = parsed.unresolved;
      return " ";
    })
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  const beat: Beat = { text };
  if (visual) beat.visual = visual;
  else if (unresolved) beat.unresolved = unresolved;
  return beat;
}

/**
 * Splits streamed model text into beat lines as they complete. Feed deltas with
 * push(); call flush() at the end of the stream for the last line.
 */
export class BeatStreamParser {
  private pendingText = "";

  constructor(private readonly context: ResolveContext) {}

  push(delta: string): Beat[] {
    this.pendingText += delta;
    const beats: Beat[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.pendingText.indexOf("\n")) >= 0) {
      const line = this.pendingText.slice(0, newlineIndex);
      this.pendingText = this.pendingText.slice(newlineIndex + 1);
      const beat = parseBeatLine(line, this.context);
      if (beat.text || beat.visual || beat.unresolved) beats.push(beat);
    }
    return beats;
  }

  flush(): Beat[] {
    const line = this.pendingText;
    this.pendingText = "";
    if (!line.trim()) return [];
    const beat = parseBeatLine(line, this.context);
    return beat.text || beat.visual || beat.unresolved ? [beat] : [];
  }
}

/** Removes every spatial tag, for text shown in chat history and memory. */
export function stripTags(text: string): string {
  return text.replace(tagPattern, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}
