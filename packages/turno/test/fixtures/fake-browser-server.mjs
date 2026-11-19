#!/usr/bin/env node
// A stand-in for turno-browser-mcp in `turno browser do` tests: the browser tools the command
// calls, with results shaped like upstream's (### sections), and one "tab" per client session
// (`_meta["io.turno/session"]`), so a test sees which session a call belongs to. Plain JS.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const event = (line) => {
  if (process.env.FIXTURE_EVENTS) appendFileSync(process.env.FIXTURE_EVENTS, `${line}\n`);
};
const NAMES = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_evaluate",
  "browser_find",
  "browser_take_screenshot",
  "browser_tabs",
  "browser_close",
  "browser_wait_for",
];
const tools = NAMES.map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
}));
// One page per session: its URL and the last text typed.
const pages = new Map();
const server = new Server(
  { name: "fake-browser", version: "1.0.0" },
  { capabilities: { tools: {}, experimental: { "io.turno/sessions": {} } } },
);
server.fallbackNotificationHandler = async (n) => {
  if (n.method === "notifications/io.turno/session_ended") {
    event(`session_ended ${n.params?.session}`);
    pages.delete(n.params?.session);
  }
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const ESC = String.fromCharCode(27);
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const session = req.params._meta?.["io.turno/session"] ?? "direct";
  const args = req.params.arguments ?? {};
  const name = req.params.name;
  event(`call ${name} ${session} ${JSON.stringify(args)}`);
  const page = pages.get(session) ?? { url: "about:blank", typed: "" };
  pages.set(session, page);
  const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  const pageSection = () => `### Page\n- Page URL: ${page.url}\n- Page Title: Page of ${session.slice(0, 8)}`;
  const ran = "### Ran Playwright code\n```js\nawait page.something();\n```";
  const snapLink = "### Snapshot\n- [Snapshot](.playwright-mcp/page.yml)";
  // The live view: the user paused the browser while this call waited (turno-browser's note).
  const paused = (lines) =>
    `### Paused by the user\nThe user paused this browser (the live view) for 12s and has resumed it.\nWhile you waited:\n${lines}`;
  if (process.env.FAKE_PAUSED_RAN === name)
    return text(
      `${paused("- Title: \"A\" -> \"B\"")}\nYour ${name} call ran after the resume; its result follows.\n\n${ran}\n${pageSection()}\n${snapLink}`,
    );
  if (process.env.FAKE_PAUSED_NOT_RUN === name)
    return text(
      `### Error\n${name} was not run: the user changed the browser while you waited (below).\n\n${paused("- Current tab: about:blank -> http://127.0.0.1:9/b")}\nYour ${name} call was not run: the browser changed while you waited, so the refs of your last snapshot may point elsewhere. A fresh snapshot follows; decide the next step from it.\n\n${pageSection()}\n${snapLink}`,
      true,
    );
  if (process.env.FAKE_REFUSE === name)
    return text(`### Error\n${name} is refused in read mode: Lightpanda does not lay pages out`, true);
  switch (name) {
    case "browser_navigate":
      page.url = args.url;
      return text(`${ran}\n${pageSection()}\n${snapLink}`);
    case "browser_navigate_back":
      page.url = "about:blank";
      return text(`${ran}\n${pageSection()}\n${snapLink}`);
    case "browser_snapshot":
      return text(
        `${pageSection()}\n### Snapshot\n\`\`\`yaml\n- textbox "Name" [ref=e4]\n- button "Go" [ref=e5]\n- paragraph [ref=e6]: ${session}\n\`\`\``,
      );
    case "browser_click":
      if (args.target !== "e5")
        return text(
          `### Error\nError: browserBackend.callTool: Error: Ref ${args.target} not found in the current page snapshot. Try capturing new snapshot.\nCall log:\n${ESC}[2m  - waiting${ESC}[22m`,
          true,
        );
      return text(`${ran}\n${pageSection()}\n### Events\n- New tab opened\n${snapLink}`);
    case "browser_type":
      page.typed = args.text;
      return text(`${ran}\n${pageSection()}\n${snapLink}`);
    case "browser_evaluate":
      return text(`### Result\n${JSON.stringify(`Hello from ${page.url}\n\ntyped: ${page.typed}`)}\n${ran}`);
    case "browser_find":
      return text(`### Result\nFound 1 match for "${args.text}":\n\n- button "Go" [ref=e5]`);
    case "browser_take_screenshot":
      return {
        content: [
          { type: "text", text: `### Result\n- [Screenshot of viewport](.playwright-mcp/page.png)\n${ran}` },
          { type: "image", mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") },
        ],
      };
    case "browser_tabs":
      return text(`### Result\n- 0: (current) [Page](${page.url})`);
    case "browser_wait_for":
      return text(`### Result\nWaited for ${args.text}\n${ran}\n${pageSection()}`);
    case "browser_close":
      pages.delete(session);
      return text("### Result\nClosed 1 tab of this session.");
    default:
      return text(`### Error\nunknown tool ${name}`, true);
  }
});
await server.connect(new StdioServerTransport());
