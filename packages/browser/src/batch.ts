import type { TurnoTool } from "./tools.js";
import { type ToolResult, type ToolSchema, upstream } from "./upstream.js";

/**
 * `browser_batch` (ADR 0051): several stock actions in one tool call. Each action runs through
 * the same path as a call of its own (the tab governor, the click diagnosis), but without the
 * page snapshot a stock action adds to its result; the batch returns one line per action and,
 * when asked, one snapshot after the last. It stops at the first action that fails.
 *
 * It saves the model a round trip per action and the server an accessibility snapshot per
 * action (`bench/browser-roundtrips.mjs` measures both).
 */

/** Most actions in one batch. */
export const MAX_BATCH = 20;

/** Longest text kept from one action's result section. */
const RESULT_CHARS = 400;

/** The sections of an upstream result text (`### Title` then the body). */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    out.set(part.slice(0, nl), part.slice(nl + 1).trim());
  }
  return out;
}

function clip(text: string, max = RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** What an action acted on, for its line: `browser_click e5`, `browser_navigate https://...`. */
function label(tool: string, args: Record<string, unknown>): string {
  const what = args.target ?? args.startTarget ?? args.url ?? args.key ?? args.action ?? args.text;
  return what === undefined ? tool : `${tool} ${clip(String(what), 80)}`;
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

function batchSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
      name: "browser_batch",
      title: "Run several browser actions",
      description: [
        "Run several browser actions in order in one call, stopping at the first one that fails.",
        "Each action names a browser tool (browser_navigate, browser_click, browser_type, browser_select_option, browser_press_key, browser_hover, browser_wait_for, ...) and its arguments, exactly as that tool takes them.",
        "Returns one short line per action instead of a snapshot after each, and one page snapshot after the last action when snapshot is true.",
        "Refs come from the snapshot taken before the batch: when an action changes the page, later refs may no longer exist, so batch actions on one page (filling a form) and take a snapshot after.",
      ].join(" "),
      inputSchema: z.object({
        actions: z
          .array(
            z.object({
              tool: z.string().describe("A browser tool name, for example browser_click"),
              arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, as it takes them"),
            }),
          )
          .min(1)
          .max(MAX_BATCH)
          .describe(`The actions, in order (at most ${MAX_BATCH})`),
        snapshot: z.boolean().optional().describe("Return a snapshot of the page after the last action (default false)"),
      }),
      type: "action",
  };
}

/** The tool. Its schema is built on first use, so importing the registry does not load the bundle. */
export function batchTool(): TurnoTool {
  let schema: ToolSchema | undefined;
  return {
    get schema() {
      schema ??= batchSchema();
      return schema;
    },
    async handle(ctx, params) {
      const actions = params.actions as { tool: string; arguments?: Record<string, unknown> }[];
      const stock = ctx.stock;
      if (!stock) throw new Error("browser_batch needs the browser host");
      // Check every action before running any, so a typo in the last one runs nothing.
      const problems: string[] = [];
      actions.forEach((a, i) => {
        const schema = stock.schemas.get(a.tool);
        if (!schema) {
          problems.push(`action ${i + 1}: "${a.tool}" is not a browser tool of this server${a.tool === "browser_batch" ? " (a batch cannot hold a batch)" : ""}`);
          return;
        }
        const parsed = schema.safeParse(a.arguments ?? {});
        if (!parsed.success) problems.push(`action ${i + 1} (${a.tool}): invalid arguments: ${stock.formatError(parsed.error)}`);
      });
      if (problems.length) {
        return { content: [{ type: "text", text: `### Error\nNothing ran.\n${problems.join("\n")}` }], isError: true };
      }

      const lines: string[] = [];
      const attachments: ToolResult["content"] = [];
      const notes: string[] = [];
      let failure: string | undefined;
      for (const [i, a] of actions.entries()) {
        const args = a.arguments ?? {};
        const result = await stock.call(a.tool, args, { snapshot: false });
        const parts = sections(textOf(result));
        const governor = parts.get("Tab governor");
        if (governor) notes.push(governor);
        attachments.push(...result.content.filter((c) => c.type !== "text"));
        if (result.isError) {
          lines.push(`${i + 1}. ${label(a.tool, args)}: failed`);
          const error = parts.get("Error") ?? textOf(result);
          const left = actions.length - i - 1;
          failure = `Action ${i + 1} of ${actions.length} (${label(a.tool, args)}) failed${left ? `; the ${left === 1 ? "last action" : `last ${left} actions`} did not run` : ""}.\n${error}`;
          break;
        }
        const res = parts.get("Result");
        lines.push(`${i + 1}. ${label(a.tool, args)}: ok${res ? `\n   ${clip(res).replace(/\n/g, "\n   ")}` : ""}`);
        const modal = parts.get("Modal state");
        if (modal) lines.push(`   ${clip(modal).replace(/\n/g, "\n   ")}`);
      }

      const out: string[] = [];
      if (failure) out.push("### Error", failure);
      out.push("### Batch", ...lines);
      if (params.snapshot === true && !failure) {
        const snap = await stock.call("browser_snapshot", {}, { snapshot: true });
        const parts = sections(textOf(snap));
        const governor = parts.get("Tab governor");
        if (governor) notes.push(governor);
        for (const title of ["Open tabs", "Page", "Modal state", "Snapshot", "Events"]) {
          const body = parts.get(title);
          if (body) out.push(`### ${title}`, body);
        }
      } else {
        const page = await stock.page();
        if (page) out.push("### Page", `- Page URL: ${page.url}`, ...(page.title ? [`- Page Title: ${page.title}`] : []));
      }
      if (notes.length) out.push("### Tab governor", ...notes);
      return { content: [{ type: "text", text: out.join("\n") }, ...attachments], ...(failure ? { isError: true } : {}) };
    },
  };
}
