import { describe, expect, it } from "vitest";
import { MAX_BATCH, batchTool } from "../src/batch.js";
import { configForSession } from "../src/host.js";
import { type StockAccess, parseArguments } from "../src/tools.js";
import { resolveTuning } from "../src/tuning.js";
import { type McpConfig, type ToolResult, upstream } from "../src/upstream.js";

/** Stock tools that answer like upstream, recording each call. */
function fakeStock(answers: Record<string, (args: Record<string, unknown>) => ToolResult> = {}) {
  const calls: { name: string; args: Record<string, unknown>; snapshot: boolean }[] = [];
  const schemas = new Map(upstream().tools.browserTools.map((t) => [t.schema.name, t.schema.inputSchema]));
  const stock: StockAccess = {
    schemas,
    formatError: (e) => upstream().utils.z.prettifyError(e),
    async call(name, args, { snapshot }) {
      calls.push({ name, args, snapshot });
      const answer = answers[name];
      if (answer) return answer(args);
      return { content: [{ type: "text", text: `### Ran Playwright code\n\`\`\`js\nawait page.x();\n\`\`\`${snapshot ? "\n### Snapshot\n- big tree" : ""}` }] };
    },
    page: async () => ({ url: "http://127.0.0.1/form", title: "Sign up" }),
    currentPage: () => undefined,
  };
  return { stock, calls };
}

async function run(stock: StockAccess, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = batchTool();
  const parsed = parseArguments(tool, params);
  if ("error" in parsed) return { text: parsed.error, isError: true };
  const res = await tool.handle({ config: {} as McpConfig, clientInfo: { cwd: "/", clientName: "t" }, stock }, parsed.params);
  return { text: res.content.map((c) => (c as { text?: string }).text ?? "").join("\n"), isError: !!res.isError };
}

describe("browser_batch", () => {
  it("runs each action without its snapshot and returns one line per action and the page", async () => {
    const { stock, calls } = fakeStock();
    const res = await run(stock, {
      actions: [
        { tool: "browser_type", arguments: { target: "e3", text: "Alice" } },
        { tool: "browser_click", arguments: { target: "e7" } },
      ],
    });
    expect(res.isError).toBe(false);
    expect(calls.map((c) => [c.name, c.snapshot])).toEqual([
      ["browser_type", false],
      ["browser_click", false],
    ]);
    expect(res.text).toContain("### Batch\n1. browser_type e3: ok\n2. browser_click e7: ok");
    expect(res.text).toContain("### Page\n- Page URL: http://127.0.0.1/form\n- Page Title: Sign up");
    expect(res.text).not.toContain("big tree");
  });

  it("takes one snapshot after the last action when asked", async () => {
    const { stock, calls } = fakeStock({
      browser_snapshot: () => ({ content: [{ type: "text", text: "### Page\n- Page URL: u\n### Snapshot\n```yaml\n- button \"Save\" [ref=e2]\n```" }] }),
    });
    const res = await run(stock, { actions: [{ tool: "browser_click", arguments: { target: "e7" } }], snapshot: true });
    expect(calls.map((c) => c.name)).toEqual(["browser_click", "browser_snapshot"]);
    expect(calls[1]!.snapshot).toBe(true);
    expect(res.text).toContain('### Snapshot\n```yaml\n- button "Save" [ref=e2]');
  });

  it("stops at the first failure and says which actions did not run", async () => {
    const { stock, calls } = fakeStock({
      browser_click: () => ({ content: [{ type: "text", text: "### Error\nCould not click button \"Save\": dialog covers it" }], isError: true }),
    });
    const res = await run(stock, {
      actions: [
        { tool: "browser_type", arguments: { target: "e3", text: "Alice" } },
        { tool: "browser_click", arguments: { target: "e7" } },
        { tool: "browser_press_key", arguments: { key: "Enter" } },
        { tool: "browser_press_key", arguments: { key: "Tab" } },
      ],
      snapshot: true,
    });
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["browser_type", "browser_click"]);
    expect(res.text).toMatch(/^### Error\nAction 2 of 4 \(browser_click e7\) failed; the last 2 actions did not run\.\nCould not click button "Save": dialog covers it/);
    expect(res.text).toContain("1. browser_type e3: ok\n2. browser_click e7: failed");
    expect(res.text).not.toContain("### Snapshot");
  });

  it("checks every action before running any", async () => {
    const { stock, calls } = fakeStock();
    const res = await run(stock, {
      actions: [
        { tool: "browser_click", arguments: { target: "e7" } },
        { tool: "browser_clik", arguments: {} },
        { tool: "browser_type", arguments: { target: "e3" } },
        { tool: "browser_batch", arguments: {} },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(res.text).toContain("Nothing ran.");
    expect(res.text).toContain('action 2: "browser_clik" is not a browser tool of this server');
    expect(res.text).toMatch(/action 3 \(browser_type\): invalid arguments: .*text/s);
    expect(res.text).toContain("(a batch cannot hold a batch)");
  });

  it("keeps the tab governor's notes and a dialog the page opened", async () => {
    const { stock } = fakeStock({
      browser_click: () => ({ content: [{ type: "text", text: "### Modal state\n- [\"alert\" dialog with message \"Saved\"]: can be handled by browser_handle_dialog\n### Tab governor\n- closed a popup" }] }),
    });
    const res = await run(stock, { actions: [{ tool: "browser_click", arguments: { target: "e7" } }] });
    expect(res.text).toContain('1. browser_click e7: ok\n   - ["alert" dialog with message "Saved"]');
    expect(res.text).toMatch(/### Tab governor\n- closed a popup$/);
  });

  it(`takes 1 to ${MAX_BATCH} actions`, async () => {
    const { stock } = fakeStock();
    expect((await run(stock, { actions: [] })).text).toMatch(/Invalid arguments for tool "browser_batch"/);
    const many = Array.from({ length: MAX_BATCH + 1 }, () => ({ tool: "browser_press_key", arguments: { key: "Tab" } }));
    expect((await run(stock, { actions: many })).text).toMatch(/Invalid arguments for tool "browser_batch"/);
  });
});

describe("configForSession", () => {
  const base = () => ({ server: {}, browser: { browserName: "chromium", launchOptions: {} }, timeouts: { idle: 1000, settle: 500 }, snapshot: { mode: "full" } }) as unknown as McpConfig;

  it("is a copy, with the identity's settle", () => {
    const config = base();
    const session = configForSession(config, {}, resolveTuning({ settle: "100ms" } as never));
    expect(session.timeouts).toEqual({ idle: 1000, settle: 100 });
    session.snapshot!.mode = "none";
    expect(config.snapshot!.mode).toBe("full");
    expect(config.timeouts!.settle).toBe(500);
  });

  it("leaves Playwright's settle when identity.json has none or the user set --timeout-settle", () => {
    expect(configForSession(base(), {}, resolveTuning(undefined)).timeouts!.settle).toBe(500);
    expect(configForSession(base(), { timeoutSettle: 900 }, resolveTuning({ settle: "100ms" } as never)).timeouts!.settle).toBe(500);
  });
});
