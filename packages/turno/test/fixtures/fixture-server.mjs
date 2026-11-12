#!/usr/bin/env node
// Test MCP server for mcpd integration tests. Plain JS so it runs without a build.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `spawn ${process.pid} ${process.cwd()}\n`);
let count = 0;
const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "counter", description: "Increment a per-process counter", inputSchema: { type: "object", properties: {} } },
  { name: "whoami", description: "Account, cwd and pid", inputSchema: { type: "object", properties: {} } },
  { name: "ask", description: "Ask the user for a name", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Report progress", inputSchema: { type: "object", properties: { steps: { type: "number" } } } },
];
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } }, instructions: "fixture instructions" });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
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
    case "slow": {
      const steps = Number(req.params.arguments?.steps ?? 3);
      const token = req.params._meta?.progressToken;
      for (let i = 1; i <= steps; i++) {
        if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: steps } });
        await new Promise((r) => setTimeout(r, 20));
      }
      return text("done");
    }
    default:
      throw new Error("unknown tool");
  }
});
await server.connect(new StdioServerTransport());
