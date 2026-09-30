// Seeing the screen with local vision models.
// HeyClicky's frontier models read screenshots natively; our text models
// (llama3.2:3b, llama3.3:70b) can't, so llava:13b describes the screen, starting
// the moment the hotkey goes down so the description is ready by key-up.
import sharp from "sharp";
import { isModelInstalled, resolveModel } from "../lib/models.js";
import { ollamaChat } from "../lib/ollama.js";
import { loadPrompt } from "../lib/prompts.js";

export interface ScreenCapture {
  /** 0-based index the tags refer to as screenN. */
  index: number;
  label?: string;
  /** Size of the image as sent (after the client's downscale). */
  width: number;
  height: number;
  /** Base64 JPEG/PNG without a data: prefix. */
  image: string;
  isCursorScreen?: boolean;
  /** Cursor position in this image's pixels, when the cursor is on this screen. */
  cursor?: { x: number; y: number };
}

interface TurnVisionState {
  screens: ScreenCapture[];
  description?: Promise<string>;
  createdAt: number;
}

const turnVisionStates = new Map<string, TurnVisionState>();
const turnStateLifetimeMs = 5 * 60_000;

function pruneTurnStates(): void {
  const now = Date.now();
  for (const [turnId, state] of turnVisionStates) {
    if (now - state.createdAt > turnStateLifetimeMs) turnVisionStates.delete(turnId);
  }
}

export function cursorScreen(screens: ScreenCapture[]): ScreenCapture | undefined {
  return screens.find((screen) => screen.isCursorScreen) ?? screens[0];
}

async function describeScreen(screen: ScreenCapture): Promise<string> {
  const model = await resolveModel("vision");
  if (!model.available) return "";
  const cursorNote = screen.cursor ? ` the mouse cursor is at (${Math.round(screen.cursor.x)},${Math.round(screen.cursor.y)}).` : "";
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    messages: [
      {
        role: "user",
        content: `${loadPrompt("vision-describe")}\nthe image is ${screen.width}x${screen.height} pixels.${cursorNote}`,
        images: [screen.image],
      },
    ],
  });
  return response.message.content.trim();
}

/** Starts describing the cursor screen now; /v2/chat picks the result up by turnId. */
export function prefetchVision(turnId: string, screens: ScreenCapture[]): void {
  pruneTurnStates();
  const screen = cursorScreen(screens);
  const state: TurnVisionState = { screens, createdAt: Date.now() };
  if (screen) state.description = describeScreen(screen).catch(() => "");
  turnVisionStates.set(turnId, state);
}

/** Returns the prefetched description, or describes now if the client didn't prefetch. */
export async function visionForTurn(turnId: string | undefined, screens: ScreenCapture[] | undefined): Promise<{ description: string; screens: ScreenCapture[] }> {
  const existing = turnId ? turnVisionStates.get(turnId) : undefined;
  const effectiveScreens = screens && screens.length > 0 ? screens : existing?.screens ?? [];
  if (existing?.description) return { description: await existing.description, screens: effectiveScreens };
  const screen = cursorScreen(effectiveScreens);
  if (!screen) return { description: "", screens: effectiveScreens };
  const description = await describeScreen(screen).catch(() => "");
  if (turnId) turnVisionStates.set(turnId, { screens: effectiveScreens, description: Promise.resolve(description), createdAt: Date.now() });
  return { description, screens: effectiveScreens };
}

export function screensForTurn(turnId: string | undefined): ScreenCapture[] {
  return (turnId && turnVisionStates.get(turnId)?.screens) || [];
}

// ---------------------------------------------------------------------------
// Grounding: find a described thing's pixel position when there's no UI
// element for it (canvas apps, games, some Electron surfaces).

export interface GroundingResult {
  x: number;
  y: number;
  width: number;
  height: number;
  screen: number;
  method: "bbox" | "grid";
}

async function groundWithBoundingBoxModel(screen: ScreenCapture, description: string): Promise<GroundingResult | undefined> {
  const model = await resolveModel("grounding");
  if (!model.available) return undefined;
  // Qwen2.5-VL answers in the pixel space of the image it actually saw. Send an
  // image already sized to multiples of 28 (its patch size) and under ~1 MP so
  // Ollama doesn't resize it again, then scale the box back to the screenshot.
  const longEdge = 1288;
  const aspect = screen.height / screen.width;
  const sentWidth = screen.width >= screen.height ? longEdge : Math.max(28, Math.round(longEdge / aspect / 28) * 28);
  const sentHeight = screen.width >= screen.height ? Math.max(28, Math.round((longEdge * aspect) / 28) * 28) : longEdge;
  const resizedImage = await sharp(Buffer.from(screen.image, "base64"))
    .resize({ width: sentWidth, height: sentHeight, fit: "fill" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const response = await ollamaChat({
    model: model.model,
    keep_alive: model.keepAlive,
    options: model.options,
    format: {
      type: "object",
      properties: { found: { type: "boolean" }, bbox_2d: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } },
      required: ["found", "bbox_2d"],
    },
    messages: [
      {
        role: "user",
        content: `locate "${description}" in this screenshot. reply as json {"found": true|false, "bbox_2d": [x1, y1, x2, y2]} in pixels of this image.`,
        images: [resizedImage.toString("base64")],
      },
    ],
  });
  const parsed = JSON.parse(response.message.content) as { found: boolean; bbox_2d: number[] };
  if (!parsed.found || parsed.bbox_2d.length !== 4) return undefined;
  const scaleX = screen.width / sentWidth;
  const scaleY = screen.height / sentHeight;
  const [x1, y1, x2, y2] = [parsed.bbox_2d[0] * scaleX, parsed.bbox_2d[1] * scaleY, parsed.bbox_2d[2] * scaleX, parsed.bbox_2d[3] * scaleY];
  const clampX = (value: number) => Math.max(0, Math.min(screen.width, value));
  const clampY = (value: number) => Math.max(0, Math.min(screen.height, value));
  return {
    x: clampX(Math.min(x1, x2)),
    y: clampY(Math.min(y1, y2)),
    width: Math.max(4, Math.abs(x2 - x1)),
    height: Math.max(4, Math.abs(y2 - y1)),
    screen: screen.index,
    method: "bbox",
  };
}

/**
 * Zoom search with llava: ask which cell of a 3x3 grid holds the target, crop
 * to that cell, and repeat. Two rounds give roughly 1/9 x 1/9 of the screen.
 */
async function groundWithGridZoom(screen: ScreenCapture, description: string, rounds = 2): Promise<GroundingResult | undefined> {
  const model = await resolveModel("vision");
  if (!model.available) return undefined;
  let region = { left: 0, top: 0, width: screen.width, height: screen.height };
  const source = sharp(Buffer.from(screen.image, "base64"));
  const metadata = await source.metadata();
  // The client may have sent an image whose true size differs from width/height; scale regions accordingly.
  const scaleX = (metadata.width ?? screen.width) / screen.width;
  const scaleY = (metadata.height ?? screen.height) / screen.height;
  for (let round = 0; round < rounds; round += 1) {
    const crop = await sharp(Buffer.from(screen.image, "base64"))
      .extract({
        left: Math.round(region.left * scaleX),
        top: Math.round(region.top * scaleY),
        width: Math.max(1, Math.round(region.width * scaleX)),
        height: Math.max(1, Math.round(region.height * scaleY)),
      })
      .resize({ width: 672, height: 672, fit: "inside" })
      .jpeg({ quality: 80 })
      .toBuffer();
    const response = await ollamaChat({
      model: model.model,
      keep_alive: model.keepAlive,
      options: { temperature: 0, num_ctx: 4096, num_predict: 30 },
      format: { type: "object", properties: { cell: { type: "integer", minimum: 0, maximum: 9 } }, required: ["cell"] },
      messages: [
        {
          role: "user",
          content: `split this image into a 3x3 grid. cells are numbered 1 2 3 on the top row, 4 5 6 in the middle, 7 8 9 on the bottom. which cell contains "${description}"? reply as json {"cell": n}, or {"cell": 0} if it isn't visible.`,
          images: [crop.toString("base64")],
        },
      ],
    });
    const cell = (JSON.parse(response.message.content) as { cell: number }).cell;
    if (!cell || cell < 1 || cell > 9) return round === 0 ? undefined : { ...regionToResult(region), screen: screen.index, method: "grid" };
    const column = (cell - 1) % 3;
    const row = Math.floor((cell - 1) / 3);
    region = {
      left: region.left + (column * region.width) / 3,
      top: region.top + (row * region.height) / 3,
      width: region.width / 3,
      height: region.height / 3,
    };
  }
  return { ...regionToResult(region), screen: screen.index, method: "grid" };
}

function regionToResult(region: { left: number; top: number; width: number; height: number }) {
  return { x: Math.round(region.left), y: Math.round(region.top), width: Math.round(region.width), height: Math.round(region.height) };
}

export async function groundDescription(screens: ScreenCapture[], screenIndex: number, description: string): Promise<GroundingResult | undefined> {
  const screen = screens.find((candidate) => candidate.index === screenIndex) ?? cursorScreen(screens);
  if (!screen || !description.trim()) return undefined;
  try {
    if (isModelInstalled((await resolveModel("grounding")).model)) {
      const result = await groundWithBoundingBoxModel(screen, description);
      if (result) return result;
    }
    return await groundWithGridZoom(screen, description);
  } catch (error) {
    console.warn("[vision] grounding failed:", (error as Error).message);
    return undefined;
  }
}
