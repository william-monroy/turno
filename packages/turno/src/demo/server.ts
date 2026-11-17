/**
 * The MCP server `turno demo` puts behind its gateway: a few harmless tools, no network, no
 * files. `node server.js <name>` serves as <name>; DEMO_ACCOUNT (set by a profile variant in the
 * demo's mcp.toml) shows which account's process answered.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const name = process.argv[2] ?? "demo";
const account = process.env.DEMO_ACCOUNT ?? "shared";
const startedAt = new Date().toISOString();
let calls = 0;

const tools = [
  { name: "whoami", description: `Which ${name} process answered: account, pid, start time and calls served`, inputSchema: { type: "object", properties: {} } },
  { name: "echo", description: "Return the text it is given", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];

const server = new Server({ name: `turno-demo-${name}`, version: "1.0.0" }, { capabilities: { tools: {} }, instructions: `A demo server of turno (${name}).` });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  calls++;
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  switch (req.params.name) {
    case "whoami":
      return text(JSON.stringify({ server: name, account, pid: process.pid, startedAt, calls }));
    case "echo":
      return text(String(req.params.arguments?.text ?? ""));
    default:
      return { ...text(`unknown tool ${req.params.name}`), isError: true };
  }
});

await server.connect(new StdioServerTransport());
// Exit when the gateway closes the pipe, so no demo process outlives the demo.
process.stdin.on("end", () => process.exit(0));
