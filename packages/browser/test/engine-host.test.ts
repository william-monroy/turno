import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Engine, type LaunchRequest, createEngine } from "../src/engine.js";
import { createHost, serve } from "../src/host.js";
import { writeIdentitySettings } from "../src/settings.js";
import { TURNO_TOOLS } from "../src/tools.js";
import { type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * How the host uses the engine module, without a browser: a tool an engine refuses fails
 * with the engine's reason before anything launches, also as a step of browser_batch, and the
 * engine for an identity follows its identity.json and the server flags at every call.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

async function config(): Promise<McpConfig> {
  return await upstream().tools.resolveCLIConfigForMCP({ browser: "chrome", userDataDir: `${sb.home}/profile` }, {});
}

function refusingEngine(refused: string): Engine & { launches: LaunchRequest[] } {
  const launches: LaunchRequest[] = [];
  return {
    id: "lightpanda",
    launches,
    refuse: (tool) => (tool === refused ? `${tool} is refused by this engine` : undefined),
    async launch(request) {
      launches.push(request);
      throw new Error("no browser in this test");
    },
  };
}

async function connect(cfg: McpConfig, engine: Engine, identity?: { id: string; env: NodeJS.ProcessEnv }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(
    createHost({ config: cfg, cliOptions: {}, turnoTools: TURNO_TOOLS, engine, ...(identity ? { identity } : {}) }),
    serverSide,
  );
  const client = new Client({ name: "engine-host-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (res: unknown) => ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("engine refusals in the host", () => {
  it("refuses a stock tool before the browser launches", async () => {
    const engine = refusingEngine("browser_take_screenshot");
    const client = await connect(await config(), engine);
    const res = await client.callTool({ name: "browser_take_screenshot", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("browser_take_screenshot is refused by this engine");
    expect(engine.launches).toEqual([]);
  });

  it("refuses a turno tool the same way", async () => {
    const engine = refusingEngine("browser_login");
    const client = await connect(await config(), engine);
    const res = await client.callTool({ name: "browser_login", arguments: { site: "example.com" } });
    expect(text(res)).toContain("browser_login is refused by this engine");
    expect(engine.launches).toEqual([]);
  });

  it("refuses a browser_batch with a refused step before the browser launches", async () => {
    const engine = refusingEngine("browser_take_screenshot");
    const client = await connect(await config(), engine);
    const res = await client.callTool({
      name: "browser_batch",
      arguments: {
        actions: [
          { tool: "browser_snapshot", arguments: {} },
          { tool: "browser_take_screenshot", arguments: {} },
        ],
      },
    });
    expect(text(res)).toContain("browser_take_screenshot is refused by this engine");
    expect(engine.launches).toEqual([]);
  });
});

describe("createEngine", () => {
  it("follows identity.json at every call: read mode refuses a screenshot, Chrome does not", async () => {
    const cfg = await config();
    const engine = createEngine(cfg);
    const identity = { id: "reader", env: sb.env };
    expect(engine.refuse?.("browser_take_screenshot", identity)).toBeUndefined();
    writeIdentitySettings("reader", { engine: "lightpanda" }, sb.env);
    expect(engine.refuse?.("browser_take_screenshot", identity)).toMatch(/read mode/);
    expect(engine.refuse?.("browser_snapshot", identity)).toBeUndefined();
    writeIdentitySettings("reader", { engine: null, attach: "auto" }, sb.env);
    expect(engine.refuse?.("browser_run_code_unsafe", identity)).toMatch(/attach mode/);
    expect(engine.refuse?.("browser_take_screenshot", identity)).toBeUndefined();
  });

  it("lets a server flag win over identity.json", () => {
    writeIdentitySettings("reader", { engine: "lightpanda" }, sb.env);
    return config().then((cfg) => {
      const engine = createEngine(cfg, { engine: "chrome" });
      expect(engine.refuse?.("browser_take_screenshot", { id: "reader", env: sb.env })).toBeUndefined();
      expect(createEngine(cfg, { engine: "lightpanda" }).refuse?.("browser_take_screenshot")).toMatch(/read mode/);
    });
  });

  it("refuses traces or screenshots in attach or read mode chosen by a flag, before anything starts", async () => {
    writeIdentitySettings("rec", { record: { flows: true, traces: true } }, sb.env);
    const identity = { id: "rec", env: sb.env };
    for (const [flags, why] of [
      [{ attach: "auto" }, /record\.traces do not go with attach mode: a trace or screenshot could show your own tabs/],
      [{ engine: "lightpanda" }, /record\.traces do not go with engine "lightpanda": read mode renders no page/],
    ] as const) {
      const client = await connect(await config(), createEngine(await config(), flags), identity);
      const res = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(why);
    }
    // Flows alone need neither, so they go with both.
    writeIdentitySettings("rec", { record: { flows: true } }, sb.env);
    const env = { ...sb.env, PATH: "" };
    const client = await connect(await config(), createEngine(await config(), { engine: "lightpanda" }), {
      id: "rec",
      env,
    });
    const res = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
    expect(text(res)).toMatch(/read mode needs Lightpanda/);
  });

  it("reports a missing Lightpanda as a tool error with the install command", async () => {
    const env = { ...sb.env, PATH: "" };
    writeIdentitySettings("reader", { engine: "lightpanda" }, env);
    const client = await connect(await config(), createEngine(await config()), { id: "reader", env });
    const res = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/read mode needs Lightpanda.*Install it/);
  });
});
