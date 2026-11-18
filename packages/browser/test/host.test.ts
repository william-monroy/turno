import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Engine, type LaunchRequest, selectEngine, usesChromeEngine } from "../src/engine.js";
import { SERVER_INFO, createHost, mergeTextParts, serve } from "../src/host.js";
import { TURNO_TOOLS, type TurnoTool, checkTurnoTools, turnoZod } from "../src/tools.js";
import { type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The host in process, without a browser: the tool list, the turno tool registry, how calls
 * are routed, and which engine a config selects. A fake engine records launches and fails
 * them, so nothing here starts Chrome (the real Chrome runs are in chrome-lifecycle.test.ts).
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

async function config(options: Record<string, unknown> = {}): Promise<McpConfig> {
  return await upstream().tools.resolveCLIConfigForMCP({ browser: "chrome", userDataDir: `${sb.home}/profile`, ...options }, {});
}

/** A test-only turno tool: echoes its argument without the browser. */
function echoTool(): TurnoTool {
  const z = turnoZod();
  return {
    schema: {
      name: "turno_test_echo",
      title: "Echo (test)",
      description: "Returns its text argument.",
      inputSchema: z.object({ text: z.string().describe("Text to echo") }),
      type: "readOnly",
    },
    browser: false,
    async handle(ctx, params) {
      return { content: [{ type: "text", text: `echo: ${String(params.text)}` }, { type: "text", text: `client: ${ctx.clientInfo.clientName}` }] };
    },
  };
}

function failingEngine(): Engine & { launches: LaunchRequest[] } {
  const launches: LaunchRequest[] = [];
  return {
    id: "chrome",
    launches,
    async launch(request) {
      launches.push(request);
      throw new Error("no browser in this test");
    },
  };
}

async function connect(cfg: McpConfig, turnoTools: TurnoTool[], engine: Engine): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(createHost({ config: cfg, cliOptions: {}, turnoTools, engine }), serverSide);
  const client = new Client({ name: "host-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("host", () => {
  it("lists the stock tools first, then the turno tools, rendered like stock tools", async () => {
    const client = await connect(await config(), [echoTool()], failingEngine());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(26);
    expect(names.at(-1)).toBe("turno_test_echo");
    expect(names.slice(0, 2)).toEqual(["browser_close", "browser_resize"]);
    const echo = tools.at(-1)!;
    expect(echo.annotations).toEqual({ title: "Echo (test)", readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(echo.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string", description: "Text to echo" } }, required: ["text"] });
    expect(client.getServerVersion()).toEqual(SERVER_INFO);
    await client.close();
  });

  it("calls a turno tool without launching the browser, and joins its text parts", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [echoTool()], engine);
    const res = await client.callTool({ name: "turno_test_echo", arguments: { text: "hi" } });
    expect(res).toEqual({ content: [{ type: "text", text: "echo: hi\nclient: host-test" }] });
    expect(engine.launches).toEqual([]);
    await client.close();
  });

  it("rejects bad arguments of a turno tool with upstream's message", async () => {
    const client = await connect(await config(), [echoTool()], failingEngine());
    const res = await client.callTool({ name: "turno_test_echo", arguments: { text: 5 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/^### Error\nInvalid arguments for tool "turno_test_echo":\n.*expected string/s);
    await client.close();
  });

  it("sends stock tools to the engine's browser, launched on demand, and reports a failed launch as a tool error", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [], engine);
    expect(engine.launches).toEqual([]);
    const res = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(res).toEqual({ content: [{ type: "text", text: "### Error\nError: no browser in this test" }], isError: true });
    // The next call tries again instead of keeping the failure.
    await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(engine.launches).toHaveLength(2);
    expect(engine.launches[0]).toMatchObject({ title: "host-test", clientInfo: { clientName: "host-test", cwd: process.cwd() } });
    expect(engine.launches[1]!.title).toBe("host-test (2)");
    await client.close();
  });
});

describe("turno tool registry", () => {
  const stock = () => upstream().tools.browserTools;

  it("ships no user-facing turno tools yet", () => {
    expect(TURNO_TOOLS).toEqual([]);
  });

  it("refuses a turno tool with the name of any upstream tool, a duplicate or a bad name", () => {
    const named = (name: string): TurnoTool => ({ ...echoTool(), schema: { ...echoTool().schema, name } });
    expect(() => checkTurnoTools([named("browser_snapshot")], stock())).toThrow(/name of a Playwright MCP tool/);
    // Capability-gated tools count too, enabled or not.
    expect(() => checkTurnoTools([named("browser_pdf_save")], stock())).toThrow(/name of a Playwright MCP tool/);
    expect(() => checkTurnoTools([named("turno_x"), named("turno_x")], stock())).toThrow(/twice/);
    expect(() => checkTurnoTools([named("Turno-X")], stock())).toThrow(/must match/);
    expect(() => checkTurnoTools([echoTool()], stock())).not.toThrow();
  });

  it("is checked when the host starts", async () => {
    const clash: TurnoTool = { ...echoTool(), schema: { ...echoTool().schema, name: "browser_navigate" } };
    expect(() => createHost({ config: { server: {} } as McpConfig, cliOptions: {}, turnoTools: [clash] })).toThrow(/name of a Playwright MCP tool/);
  });
});

describe("engine selection", () => {
  it("launches the default persistent Chrome itself and hands every other mode to upstream", async () => {
    const fallback = failingEngine();
    fallback.id = "upstream";
    expect(usesChromeEngine(await config())).toBe(true);
    expect(selectEngine(await config(), fallback).id).toBe("chrome");
    for (const options of [
      { isolated: true, userDataDir: undefined },
      { cdpEndpoint: "http://127.0.0.1:9222" },
      { extension: true },
      { sharedBrowserContext: true },
      { browser: "firefox" },
      { userDataDir: undefined },
    ]) {
      const cfg = await config(options);
      expect(selectEngine(cfg, fallback).id, JSON.stringify(options)).toBe("upstream");
    }
  });
});

describe("mergeTextParts", () => {
  it("joins runs of text parts and keeps other parts in place, like upstream", () => {
    const image = { type: "image", data: "AA", mimeType: "image/png" };
    expect(
      mergeTextParts({
        content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, image, { type: "text", text: "c" }],
        isError: false,
      }),
    ).toEqual({ content: [{ type: "text", text: "a\nb" }, image, { type: "text", text: "c" }], isError: false });
  });
});
