import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { api } from "turno-browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { browserCommand, defaultDeps } from "../src/cli/commands/browser.js";
import type { DoDeps } from "../src/cli/commands/browser-do.js";
import { CliError, UsageError } from "../src/cli/io.js";
import { type RunningDaemon, startDaemon } from "../src/mcpd/daemon.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `turno browser do` against a real Google Chrome: mcpd (in process) serves a browser identity
 * with turno-browser-mcp from this workspace, headless, on a profile in the sandbox HOME, with
 * "sharing": "tabs", humanize light and flow recording on. Two named CLI sessions work in their
 * own tabs. Skipped when Chrome is missing (or with TURNO_SKIP_CHROME=1); cleanup only signals
 * processes whose command line names the sandbox.
 */

const CHROME: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/opt/google/chrome/chrome",
};
const BIN = fileURLToPath(new URL("../../browser/dist/bin/mcp.js", import.meta.url));

function skipReason(): string | undefined {
  if (process.env.TURNO_SKIP_CHROME === "1") return "TURNO_SKIP_CHROME=1";
  const exe = CHROME[process.platform];
  if (!exe || !existsSync(exe)) return "Google Chrome is not installed";
  if (!existsSync(BIN)) return "turno-browser is not built (pnpm build)";
  return undefined;
}
const reason = skipReason();

let sb: Sandbox;
let web: { url: string; server: Server };
let daemon: RunningDaemon | undefined;
const deps: DoDeps = { owner: () => ({ pid: process.pid, command: "node vitest" }), stdin: async () => "" };

beforeAll(async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const path = (req.url ?? "/").split("?")[0];
    res.end(
      path === "/form"
        ? `<title>Form</title><h1>Form</h1><input aria-label="Name"><button onclick="document.querySelector('p').textContent='Hi ' + document.querySelector('input').value">Greet</button><p>nobody yet</p>`
        : `<title>Other</title><h1>Other page</h1>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  web = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
});

afterAll(async () => {
  await new Promise((resolve) => web.server.close(resolve));
});

beforeEach(() => {
  sb = sandbox();
});

afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = undefined;
  // Chrome closes with turno-browser-mcp; anything left that names the sandbox goes.
  const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  for (const line of out.split("\n").filter((l) => l.includes(sb.home))) {
    try {
      process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
    } catch {
      /* gone */
    }
  }
  sb.cleanup();
});

async function run(args: string[]) {
  const io = fakeIo(sb.env);
  let code: number;
  try {
    code = await browserCommand(defaultDeps, deps).run(args, io);
  } catch (err) {
    if (!(err instanceof UsageError) && !(err instanceof CliError)) throw err;
    code = err instanceof CliError ? err.code : 2;
    io.err((err as Error).message);
  }
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe.skipIf(reason !== undefined)(
  `turno browser do with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`,
  () => {
    it("drives the identity's browser by ref, one tab per CLI session, recorded as the session's flow", async () => {
      api.addIdentity("school", sb.env);
      api.writeIdentitySettings(
        "school",
        { sharing: "tabs", humanize: { level: "light", seed: 7 }, record: { flows: true } },
        sb.env,
      );
      sb.write(".config/turno/config.toml", "");
      sb.write(
        ".config/turno/mcp.toml",
        [
          "[server.browser-school]",
          `command = ${JSON.stringify(process.execPath)}`,
          `args = [${JSON.stringify(BIN)}, "--identity", "school", "--headless"]`,
          `scope = "shared"`,
          "exclusive = false",
          "",
        ].join("\n"),
      );
      daemon = await startDaemon({ env: sb.env, port: 0 });

      const open = await run(["do", "school", "open", `${web.url}/form`]);
      expect(open.err).toBe("");
      expect(open.out.split("\n").slice(0, 2)).toEqual([`url: ${web.url}/form`, "title: Form"]);

      const snap = await run(["do", "school", "snapshot"]);
      expect(snap.code).toBe(0);
      const field = /textbox "Name" \[ref=(e\d+)\]/.exec(snap.out)?.[1];
      const button = /button "Greet" \[ref=(e\d+)\]/.exec(snap.out)?.[1];
      expect(field && button).toBeTruthy();

      expect((await run(["do", "school", "type", field!, "Ada"])).code).toBe(0);
      expect((await run(["do", "school", "click", button!])).code).toBe(0);
      const read = await run(["do", "school", "read"]);
      expect(read.out).toContain("Hi Ada");

      // A second session opens its own tab; the first keeps its page.
      const other = await run(["do", "school", "open", `${web.url}/other`, "--session", "two"]);
      expect(other.out).toContain("title: Other");
      const tabs = await run(["do", "school", "tabs"]);
      expect(tabs.out).toMatch(/\(current\).*\/form/);
      expect(tabs.out).toMatch(/\/other.*\(in use by session /);
      expect((await run(["do", "school", "read"])).out).toContain("Hi Ada");

      // A bad ref fails with upstream's own words.
      const bad = await run(["do", "school", "click", "e999"]);
      expect(bad.code).toBe(1);
      expect(bad.err).toMatch(/^error: .*e999/);

      // record.flows: each CLI session is one flow (open, type, click; then the other session's open).
      const flows = api.listFlows("school", sb.env).filter((f) => f.auto);
      expect(flows.map((f) => f.steps).sort()).toEqual([1, 3]);

      expect((await run(["do", "school", "end"])).code).toBe(0);
      expect((await run(["do", "school", "end", "--session", "two"])).code).toBe(0);
    }, 120_000);
  },
);
