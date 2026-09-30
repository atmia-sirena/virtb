import { describe, expect, it } from "vitest";
import { BeatStreamParser, buildResolveContext, parseBeatLine, stripTags, type ScreenElement } from "../src/talk/tags.js";

const elements: ScreenElement[] = [
  { id: "e7", name: "Export", role: "button", rect: [1180, 20, 80, 30], screen: 0 },
  { id: "e12", name: "File name", role: "edit", rect: [100, 400, 300, 24], screen: 1 },
];
const context = buildResolveContext(elements, 0);

describe("parseBeatLine", () => {
  it("resolves an element id to its center on the element's screen", () => {
    const beat = parseBeatLine("[POINT:#e7:export] hit export up here.", context);
    expect(beat.text).toBe("hit export up here.");
    expect(beat.visual).toMatchObject({ kind: "point", screen: 0, points: [[1220, 35]], label: "export", elementId: "e7" });
  });

  it("keeps HeyClicky's pixel form with a screen suffix", () => {
    const beat = parseBeatLine("[POINT:640,360:the play button:screen1] press play", context);
    expect(beat.visual).toMatchObject({ kind: "point", screen: 1, points: [[640, 360]], label: "the play button" });
  });

  it("parses TARGET with radius and element form with a computed radius", () => {
    expect(parseBeatLine("[TARGET:120,210,40:add modifier] Click Add Modifier.", context).visual).toMatchObject({ kind: "target", points: [[120, 210]], radius: 40 });
    const fromElement = parseBeatLine("[TARGET:#e12:name field] click the name field", context).visual!;
    expect(fromElement.kind).toBe("target");
    expect(fromElement.screen).toBe(1);
    expect(fromElement.radius).toBeGreaterThan(14);
  });

  it("parses highlight rectangles and shapes", () => {
    expect(parseBeatLine("[HIGHLIGHT:10,20,110,70:area] here", context).visual).toMatchObject({ kind: "highlight", rect: [10, 20, 100, 50] });
    expect(parseBeatLine("[HIGHLIGHT:#e12:field] type here", context).visual?.rect).toEqual([100, 400, 300, 24]);
    expect(parseBeatLine("[SHAPE:circle:100,100;130,100:dot] this one", context).visual).toMatchObject({ kind: "circle", radius: 30 });
    expect(parseBeatLine("[SHAPE:arrow:#e12>#e7:go] from here to there", context).visual).toMatchObject({ kind: "arrow", points: [[250, 412], [1220, 35]] });
    expect(parseBeatLine("[SHAPE:polygon:0,0;10,0;10,10:tri] x", context).visual?.points).toHaveLength(3);
  });

  it("flags unknown ids and plain descriptions for grounding", () => {
    expect(parseBeatLine("[POINT:#e99:save] save it", context).unresolved).toMatchObject({ tag: "POINT", label: "save" });
    expect(parseBeatLine("[POINT:the red record button] press record", context).unresolved).toMatchObject({ label: "the red record button" });
  });

  it("handles OPEN, DONE, POINT:none and tags at the end of a line", () => {
    expect(parseBeatLine("[OPEN:https://maps.google.com/?q=coffee] opening maps", context).visual).toMatchObject({ kind: "open", url: "https://maps.google.com/?q=coffee" });
    expect(parseBeatLine("all done! [DONE]", context)).toMatchObject({ text: "all done!", visual: { kind: "done" } });
    expect(parseBeatLine("[POINT:none] nothing to show", context)).toEqual({ text: "nothing to show" });
    expect(parseBeatLine("it's right there [POINT:#e7:export]", context).visual?.kind).toBe("point");
  });
});

describe("BeatStreamParser", () => {
  it("emits beats only when lines complete, across arbitrary chunking", () => {
    const parser = new BeatStreamParser(context);
    const text = "[POINT:#e7:export] hit export.\nthen pick png.";
    const beats = [];
    for (const piece of text.match(/.{1,3}/gs)!) beats.push(...parser.push(piece));
    expect(beats).toHaveLength(1);
    beats.push(...parser.flush());
    expect(beats.map((beat) => beat.text)).toEqual(["hit export.", "then pick png."]);
  });
});

it("stripTags removes every tag", () => {
  expect(stripTags("[POINT:#e7:x] hi\n[DONE] bye")).toBe("hi\nbye");
});
