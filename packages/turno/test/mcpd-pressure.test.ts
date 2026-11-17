import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { parseConfig } from "../src/core/config.js";
import { type Manifest, parseManifest } from "../src/core/manifest.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { Gateway } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { type PressureLevel, darwinLevel, effectiveIdle, freeMemLevel, memoryPressureProbe, parsePsi } from "../src/mcpd/pressure.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const TOKEN = "test-token";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

describe("memory pressure signals", () => {
  it("reads Linux PSI", () => {
    const calm = "some avg10=0.00 avg60=0.00 avg300=0.00 total=12\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=3\n";
    const busy = "some avg10=12.50 avg60=3.00 avg300=1.00 total=99\nfull avg10=1.00 avg60=0.10 avg300=0.00 total=9\n";
    const stalled = "some avg10=55.00 avg60=20.00 avg300=5.00 total=999\nfull avg10=12.00 avg60=3.00 avg300=1.00 total=99\n";
    expect(parsePsi(calm)).toBe("normal");
    expect(parsePsi(busy)).toBe("warn");
    expect(parsePsi(stalled)).toBe("critical");
    expect(parsePsi("garbage")).toBeUndefined();
  });

  it("maps the macOS kernel level and free memory", () => {
    expect(darwinLevel(1)).toBe("normal");
    expect(darwinLevel(2)).toBe("warn");
    expect(darwinLevel(4)).toBe("critical");
    expect(darwinLevel(0)).toBeUndefined();
    expect(freeMemLevel(50, 100)).toBe("normal");
    expect(freeMemLevel(8, 100)).toBe("warn");
    expect(freeMemLevel(3, 100)).toBe("critical");
  });

  it("prefers PSI on Linux, the sysctl on macOS, and falls back to free memory", async () => {
    const proc = join(sb.home, "proc");
    mkdirSync(join(proc, "pressure"), { recursive: true });
    writeFileSync(join(proc, "pressure", "memory"), "some avg10=20.00 avg60=0 avg300=0 total=1\nfull avg10=0.00 avg60=0 avg300=0 total=1\n");
    const mem = { freemem: () => 90, totalmem: () => 100 };
    expect(await memoryPressureProbe({ platform: "linux", procRoot: proc, ...mem })()).toBe("warn");
    expect(await memoryPressureProbe({ platform: "linux", procRoot: join(sb.home, "none"), freemem: () => 2, totalmem: () => 100 })()).toBe("critical");
    expect(await memoryPressureProbe({ platform: "darwin", sysctl: async () => "4\n", ...mem })()).toBe("critical");
    expect(await memoryPressureProbe({ platform: "darwin", sysctl: async () => { throw new Error("no sysctl"); }, ...mem })()).toBe("normal");
  });

  it("shrinks the idle limit under pressure and never lengthens it", () => {
    expect(effectiveIdle(1800, "normal", 300)).toBe(1800);
    expect(effectiveIdle(1800, "warn", 300)).toBe(300);
    expect(effectiveIdle(1800, "critical", 300)).toBe(75);
    expect(effectiveIdle(60, "warn", 300)).toBe(60);
    expect(effectiveIdle(1800, "critical", 0)).toBe(1800); // off
  });
});

describe("reaping under memory pressure", () => {
  let manager: InstanceManager;
  let gw: Gateway;
  let manifest: Manifest;
  let level: PressureLevel;
  let skew = 0;
  const clients: Client[] = [];
  const lines: string[] = [];

  async function boot(extra: string, idleUnderPressure = 300): Promise<number> {
    manifest = parseManifest(`[server.fx]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FIXTURE)}]\n${extra}\n`);
    level = "normal";
    skew = 0;
    manager = new InstanceManager({
      now: () => Date.now() + skew,
      cache: new DescriptionCache(join(sb.home, "cache")),
      connector: new DefaultConnector({ resolve: async (v) => v, serversDir: join(sb.home, "servers"), logsDir: join(sb.home, "logs"), baseEnv: { PATH: process.env.PATH ?? "" } }),
      home: sb.home,
      pressure: async () => level,
      idleUnderPressure,
      log: (l) => lines.push(l),
    });
    gw = new Gateway({ manager, manifest: () => manifest, token: TOKEN, processCwd: async () => undefined });
    return gw.listen(0);
  }

  async function call(port: number, headers: Record<string, string> = {}): Promise<void> {
    const c = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/fx`), {
        requestInit: { headers: { Authorization: `Bearer ${profileToken(TOKEN, "default")}`, ...headers } },
      }),
    );
    clients.push(c);
    await c.callTool({ name: "echo", arguments: { text: "x" } });
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await manager?.stopAll();
    await gw?.close();
    lines.length = 0;
  });

  it("keeps an idle shared server under normal memory, and stops it under pressure", async () => {
    await call(await boot(""));
    skew = 6 * 60_000; // 6 minutes idle; the shared default is 30
    expect(await manager.reap()).toEqual([]);
    level = "warn";
    expect(await manager.reap()).toEqual(["fx: idle (memory pressure)"]);
    expect(lines.some((l) => /memory pressure is warn/.test(l))).toBe(true);
  });

  it("uses the shorter limit when pressure is critical", async () => {
    await call(await boot(""));
    skew = 2 * 60_000;
    level = "warn";
    expect(await manager.reap()).toEqual([]);
    level = "critical";
    expect(await manager.reap()).toEqual(["fx: idle (memory pressure)"]);
  });

  it("reports the level and the idle cap in /status, and nothing while the feature is off", async () => {
    await boot("");
    const pressure = () => (gw.status() as { memoryPressure: unknown }).memoryPressure;
    // Not read yet: no level to report.
    expect(pressure()).toEqual({ level: null, checkedAt: null, idleUnderPressure: 300, idleCap: null });
    await manager.reap();
    expect(pressure()).toMatchObject({ level: "normal", idleUnderPressure: 300, idleCap: null });
    expect((pressure() as { checkedAt: number }).checkedAt).toBeGreaterThan(0);
    level = "warn";
    await manager.reap();
    expect(pressure()).toMatchObject({ level: "warn", idleCap: 300 });
    level = "critical";
    await manager.reap();
    expect(pressure()).toMatchObject({ level: "critical", idleCap: 75 });
    // config.toml turned it off: no probing, no level.
    manager.setIdleUnderPressure(0);
    await manager.reap();
    expect(pressure()).toEqual({ level: null, checkedAt: null, idleUnderPressure: 0, idleCap: null });
  });

  it("applies a new idle_under_pressure from config.toml without a restart", async () => {
    await call(await boot("", 0));
    skew = 6 * 60_000;
    level = "warn";
    expect(await manager.reap()).toEqual([]);
    manager.setIdleUnderPressure(120);
    expect(await manager.reap()).toEqual(["fx: idle (memory pressure)"]);
  });

  it("does nothing when idle_under_pressure is off", async () => {
    await call(await boot("", 0));
    skew = 6 * 60_000;
    level = "critical";
    expect(await manager.reap()).toEqual([]);
  });

  it("still keeps a session server whose owner is alive", async () => {
    await call(await boot('scope = "session"'), { "X-Turno-Pid": String(process.pid) });
    skew = 60 * 60_000;
    level = "critical";
    expect(await manager.reap()).toEqual([]);
  });

  it("survives a probe that fails", async () => {
    await call(await boot(""));
    (manager as unknown as { opts: { pressure: () => Promise<PressureLevel> } }).opts.pressure = async () => {
      throw new Error("probe broke");
    };
    skew = 6 * 60_000;
    expect(await manager.reap()).toEqual([]);
  });
});

describe("[mcpd] idle_under_pressure", () => {
  it("defaults to 5 minutes, takes durations and false", () => {
    expect(parseConfig("", "config.toml").mcpd.idleUnderPressure).toBe(300);
    expect(parseConfig('[mcpd]\nidle_under_pressure = "2m"\n', "config.toml").mcpd.idleUnderPressure).toBe(120);
    expect(parseConfig("[mcpd]\nidle_under_pressure = 90\n", "config.toml").mcpd.idleUnderPressure).toBe(90);
    expect(parseConfig("[mcpd]\nidle_under_pressure = false\n", "config.toml").mcpd.idleUnderPressure).toBe(0);
    expect(() => parseConfig('[mcpd]\nidle_under_pressure = "soon"\n', "config.toml")).toThrow(/idle_under_pressure/);
    expect(() => parseConfig("[mcpd]\nidle_under_pressure = 5\n", "config.toml")).toThrow(/idle_under_pressure/);
  });

  it("is accepted by turno config set", async () => {
    expect(await main(["config", "set", "mcpd.idle_under_pressure", "10m"], fakeIo(sb.env))).toBe(0);
    expect(readFileSync(join(sb.home, ".config/turno/config.toml"), "utf8")).toContain('idle_under_pressure = "10m"');
    expect(await main(["config", "set", "mcpd.idle_under_pressure", "false"], fakeIo(sb.env))).toBe(0);
    expect(await main(["config", "set", "mcpd.idle_under_pressure", "never"], fakeIo(sb.env))).not.toBe(0);
  });
});
