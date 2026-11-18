import { docsLlms } from "@/lib/source";

export const revalidate = false;

const INTRO = `# turno

> One MCP gateway and per-folder accounts for Claude Code, Codex, Copilot CLI and Cursor CLI.

Every page is also served as Markdown: add .md to its URL (for example /docs/concepts/gateway.md).
The whole documentation in one file: /llms-full.txt

`;

export function GET() {
  return new Response(INTRO + docsLlms.index(), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
