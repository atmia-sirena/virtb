import { describe, expect, it } from "vitest";
import { routeByRule } from "../src/talk/router.js";

describe("routeByRule", () => {
  it.each([
    ["remember that i hate em dashes", "memory"],
    ["talk slower please", "settings"],
    ["walk me through setting up a vpn", "guide"],
    ["reply to this saying i'll be late", "draft"],
    ["research the top 10 competitors in the background", "agent"],
    ["every morning find five people worth emailing", "agent"],
    ["think hard about whether this proof is right", "deep"],
    ["what is this?", "quick"],
  ])("%s -> %s", (text, route) => {
    expect(routeByRule(text)?.route).toBe(route);
  });

  it("leaves ambiguous requests to the model", () => {
    expect(routeByRule("i'm trying to figure out why my layout keeps breaking on mobile when i resize")).toBeUndefined();
  });
});
