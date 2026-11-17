#!/usr/bin/env node
// Test MCP server for mcpd integration tests. Plain JS so it runs without a build.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `spawn ${process.pid} ${process.cwd()}\n`);
/** Events the tests look for (cancellations, roots at startup, subscriptions). */
const event = (line) => {
  if (process.env.FIXTURE_EVENTS) appendFileSync(process.env.FIXTURE_EVENTS, `${line}\n`);
};
let count = 0;
const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "counter", description: "Increment a per-process counter", inputSchema: { type: "object", properties: {} } },
  { name: "whoami", description: "Account, cwd and pid", inputSchema: { type: "object", properties: {} } },
  { name: "ask", description: "Ask the user for a name", inputSchema: { type: "object", properties: {} } },
  { name: "askLater", description: "Wait, then ask the user", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "slow", description: "Report progress", inputSchema: { type: "object", properties: { steps: { type: "number" } } } },
  { name: "hang", description: "Wait ms milliseconds unless cancelled", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
  { name: "sample", description: "Ask the client's model", inputSchema: { type: "object", properties: {} } },
  { name: "roots", description: "List the client's roots", inputSchema: { type: "object", properties: {} } },
  { name: "touch", description: "Report a resource update", inputSchema: { type: "object", properties: { uri: { type: "string" } } } },
];
// Extra tools named in a file, read at start: lets a test change the tool list without changing the definition.
if (process.env.FIXTURE_TOOLS_FILE) {
  try {
    for (const name of readFileSync(process.env.FIXTURE_TOOLS_FILE, "utf8").split("\n").filter(Boolean)) {
      tools.push({ name, description: "extra", inputSchema: { type: "object", properties: {} } });
    }
  } catch {
    /* no extra tools */
  }
}
const server = new Server(
  { name: "fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, logging: {} }, instructions: "fixture instructions" },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: pathToFileURL(process.cwd()).href, name: "cwd" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  event(`subscribe ${req.params.uri}`);
  return {};
});
server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  event(`unsubscribe ${req.params.uri}`);
  return {};
});
server.oninitialized = () => {
  server
    .listRoots()
    .then((r) => event(`init-roots ${JSON.stringify(r.roots)}`))
    .catch((err) => event(`init-roots error ${err.message}`));
};
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t) }] });
  switch (req.params.name) {
    case "echo":
      return text(String(req.params.arguments?.text ?? ""));
    case "counter":
      return text(String(++count));
    case "whoami":
      return text({ account: process.env.FIXTURE_ACCOUNT ?? null, cwd: process.cwd(), pid: process.pid });
    case "ask": {
      const r = await server.elicitInput({ message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
      return text({ action: r.action, content: r.content ?? null });
    }
    case "askLater": {
      await new Promise((r) => setTimeout(r, Number(req.params.arguments?.ms ?? 300)));
      try {
        const r = await server.elicitInput({ message: "Confirm?", requestedSchema: { type: "object", properties: { n: { type: "string" } } } });
        return text({ action: r.action, content: r.content ?? null });
      } catch (err) {
        return text({ error: err.message });
      }
    }
    case "slow": {
      const steps = Number(req.params.arguments?.steps ?? 3);
      const token = req.params._meta?.progressToken;
      for (let i = 1; i <= steps; i++) {
        if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: steps } });
        await new Promise((r) => setTimeout(r, 20));
      }
      return text("done");
    }
    case "hang": {
      event(`hang ${extra.requestId}`);
      const ms = Number(req.params.arguments?.ms ?? 1000);
      await new Promise((resolve) => {
        const cancelled = () => {
          clearTimeout(t);
          event(`cancelled ${extra.requestId}`);
          resolve();
        };
        const t = setTimeout(resolve, ms);
        // The SDK aborts the signal before this handler runs when the cancellation arrived in
        // the same read as the request (a loaded machine): "abort" then never fires.
        if (extra.signal.aborted) cancelled();
        else extra.signal.addEventListener("abort", cancelled, { once: true });
      });
      return text("woke");
    }
    case "sample": {
      try {
        const r = await server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 });
        return text({ model: r.model, text: r.content.text });
      } catch (err) {
        return text({ error: err.message });
      }
    }
    case "roots": {
      try {
        return text(await server.listRoots());
      } catch (err) {
        return text({ error: err.message });
      }
    }
    case "touch": {
      await server.sendResourceUpdated({ uri: String(req.params.arguments?.uri ?? "") });
      return text("touched");
    }
    default:
      if (tools.some((t) => t.name === req.params.name)) return text("extra");
      throw new Error("unknown tool");
  }
});
// A slow start, read from a file so a test can change it without changing the definition.
if (process.env.FIXTURE_START_DELAY_FILE) {
  let ms = 0;
  try {
    ms = Number(readFileSync(process.env.FIXTURE_START_DELAY_FILE, "utf8")) || 0;
  } catch {
    /* no delay */
  }
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
await server.connect(new StdioServerTransport());
