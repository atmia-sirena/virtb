// A fake `cua-driver mcp`: one window with a Note field, a Save button and a Send button.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const state = { note: "", saved: false, actions: [] as string[] };
const server = new McpServer({ name: "fake-cua-driver", version: "0.0.1" });

server.tool("get_window_state", { pid: z.number(), window_id: z.number() }, async () => {
  const elements = [
    { role: "Edit", label: "Note", value: state.note, element_token: "tok-note", enabled: true },
    { role: "Button", label: "Save", element_token: "tok-save", enabled: true },
    { role: "Button", label: "Send", element_token: "tok-send", enabled: true },
    { role: "Text", label: state.saved ? "Saved!" : "Unsaved", element_token: "tok-status" },
  ];
  return { content: [{ type: "text", text: "window" }], structuredContent: { window: { title: "Notes" }, elements } };
});
server.tool("click", { element_token: z.string().optional(), target: z.any(), delivery_mode: z.string() }, async ({ element_token }) => {
  state.actions.push(`click ${element_token}`);
  if (element_token === "tok-save") state.saved = true;
  return { content: [{ type: "text", text: "clicked" }], structuredContent: { effect: "unverifiable" } };
});
server.tool("type_text", { text: z.string(), target: z.any() }, async ({ text }) => {
  state.note = text;
  state.actions.push(`type ${text}`);
  return { content: [{ type: "text", text: "typed" }] };
});
server.tool("get_actions", {}, async () => ({ content: [{ type: "text", text: JSON.stringify(state) }] }));

await server.connect(new StdioServerTransport());
