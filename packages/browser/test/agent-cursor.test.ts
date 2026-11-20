import type { Page } from "patchright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayCommand, OverlayReport } from "../src/agent-cursor-overlay.js";
import {
  AgentCursor,
  CURSOR_COLORS,
  agentName,
  MAX_GLIDE_MS,
  centerOf,
  cursorLabel,
  glideMs,
  inView,
  resolveCursor,
} from "../src/agent-cursor.js";
import { extractTuning } from "../src/argv.js";
import { CLIENT_META_KEY, clientFromMeta } from "../src/session.js";
import { readIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import { resolveTuning } from "../src/tuning.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The agent cursor without a browser: when it is drawn, how long the arrow glides, the labels
 * and colors of several sessions, the commands each step sends to a page, and the identity.json
 * key and flag that turn it on and off. `agent-cursor-chrome.test.ts` runs it on real Chrome.
 */

describe("resolveCursor", () => {
  it("draws it with auto when the browser can be seen: a window, or the live view", () => {
    expect(resolveCursor(undefined, { headless: false, live: false, engine: "chrome" })).toBe(true);
    expect(resolveCursor("auto", { headless: false, live: false, engine: "chrome" })).toBe(true);
    expect(resolveCursor("auto", { headless: true, live: true, engine: "chrome" })).toBe(true);
    expect(resolveCursor("auto", { headless: true, live: false, engine: "chrome" })).toBe(false);
  });

  it("follows on and off, and never draws in read mode, which lays out no page", () => {
    expect(resolveCursor("on", { headless: true, live: false, engine: "chrome" })).toBe(true);
    expect(resolveCursor("off", { headless: false, live: true, engine: "chrome" })).toBe(false);
    expect(resolveCursor("on", { headless: false, live: true, engine: "lightpanda" })).toBe(false);
    expect(resolveCursor("auto", { headless: false, live: false, engine: "camoufox" })).toBe(true);
  });
});

describe("the glide and the geometry", () => {
  it("glides longer for longer distances, never past the cap, and not at all for a step in place", () => {
    const from = { x: 100, y: 100 };
    const near = glideMs(from, { x: 150, y: 100 });
    const far = glideMs(from, { x: 700, y: 500 });
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(MAX_GLIDE_MS);
    expect(glideMs(from, { x: 100.5, y: 100 })).toBe(0);
    expect(glideMs(undefined, { x: 10, y: 10 })).toBeGreaterThan(0);
    expect(glideMs(from, { x: 900, y: 900 }, 0)).toBe(0);
  });

  it("finds the center of a box and whether some of it is in view", () => {
    expect(centerOf({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
    const view = { width: 800, height: 600 };
    expect(inView({ x: 10, y: 20, width: 100, height: 40 }, view)).toBe(true);
    expect(inView({ x: 10, y: 2000, width: 100, height: 40 }, view)).toBe(false);
    expect(inView({ x: -200, y: 20, width: 100, height: 40 }, view)).toBe(false);
    expect(inView({ x: 790, y: 590, width: 100, height: 40 }, view)).toBe(true);
  });

  it("labels a cursor with the client's name and the identity", () => {
    expect(cursorLabel("Claude Code", "school")).toBe("Claude Code · school");
    expect(cursorLabel("  ", undefined)).toBe("Agent");
  });

  it("names the agents people know by the client name they send, and keeps any other as sent", () => {
    expect(agentName("claude-code")).toBe("Claude Code");
    expect(agentName("claude-code (2)")).toBe("Claude Code (2)");
    expect(agentName("codex-mcp-client")).toBe("Codex");
    expect(agentName("cursor-vscode")).toBe("Cursor");
    expect(agentName("gemini-cli-mcp-client")).toBe("Gemini CLI");
    expect(agentName("Cursor Test Agent")).toBe("Cursor Test Agent");
    expect(agentName("my-agent")).toBe("my-agent");
  });

  it("reads the client name mcpd sends, and nothing that is not a short printable string", () => {
    expect(clientFromMeta({ [CLIENT_META_KEY]: " codex-mcp-client " })).toBe("codex-mcp-client");
    expect(clientFromMeta({ [CLIENT_META_KEY]: "" })).toBeUndefined();
    expect(clientFromMeta({ [CLIENT_META_KEY]: "x".repeat(65) })).toBeUndefined();
    expect(clientFromMeta({ [CLIENT_META_KEY]: "bad\nname" })).toBeUndefined();
    expect(clientFromMeta({ [CLIENT_META_KEY]: 7 })).toBeUndefined();
    expect(clientFromMeta(null)).toBeUndefined();
  });
});

/** A page that records what the cursor sends it, and answers like the overlay. */
function fakePage(report: Partial<OverlayReport> = {}) {
  const batches: OverlayCommand[][] = [];
  let closed = false;
  const page = {
    isClosed: () => closed,
    evaluate: async (_fn: unknown, commands: OverlayCommand[]) => {
      batches.push(commands);
      return {
        reducedMotion: false,
        width: 1200,
        height: 800,
        state: { connected: true, visible: true, busy: false, paused: false, badge: "", cursors: [] },
        ...report,
      };
    },
  };
  return {
    page: page as unknown as Page,
    batches,
    close: () => {
      closed = true;
    },
    ops: () => batches.flat().map((c) => c.op),
  };
}

describe("AgentCursor", () => {
  it("gives each agent session its own color and label, in order, and keeps them", () => {
    const cursor = new AgentCursor({ title: "Claude Code", identity: "school" });
    const a = cursor.actor("s1");
    const b = cursor.actor("s2");
    expect(a).toMatchObject({ name: "Claude Code", label: "Claude Code · school", color: CURSOR_COLORS[0] });
    expect(b).toMatchObject({ name: "Claude Code (2)", label: "Claude Code (2) · school", color: CURSOR_COLORS[1] });
    expect(cursor.actor("s1")).toBe(a);
  });

  it("names a session after its own agent when the call says it, numbering two of the same", () => {
    const cursor = new AgentCursor({ title: "turno-mcpd", identity: "school" });
    expect(cursor.actor("s1", "claude-code").label).toBe("Claude Code · school");
    expect(cursor.actor("s2", "codex-mcp-client")).toMatchObject({ name: "Codex", color: CURSOR_COLORS[1] });
    expect(cursor.actor("s3", "claude-code").label).toBe("Claude Code (2) · school");
  });

  it("tells every page it drew on how many other sessions are at work, wherever they work", async () => {
    const cursor = new AgentCursor({ title: "Claude Code" });
    const a = fakePage();
    const b = fakePage();
    await cursor.begin(a.page, "s1");
    await cursor.begin(b.page, "s2");
    // s2 begins on its own tab: s1's page hears there is one other session at work.
    await new Promise((r) => setTimeout(r, 0));
    expect(a.batches.at(-1)).toContainEqual({ op: "others", n: 1 });
    expect(b.batches.at(-1)).toContainEqual({ op: "others", n: 1 });
    await cursor.end(b.page, "s2");
    await new Promise((r) => setTimeout(r, 0));
    expect(a.batches.at(-1)).toContainEqual({ op: "others", n: 0 });
  });

  it("turns the frame on when a call begins and off when it ends, naming the session each time", async () => {
    const cursor = new AgentCursor({ title: "Codex" });
    const p = fakePage();
    await cursor.begin(p.page, "s1");
    await cursor.end(p.page, "s1");
    const [begin, end] = p.batches;
    expect(begin).toContainEqual({ op: "actor", key: "s1", label: "Codex", name: "Codex", color: CURSOR_COLORS[0] });
    expect(begin).toContainEqual({ op: "busy", key: "s1", on: true });
    expect(end).toContainEqual({ op: "busy", key: "s1", on: false });
    expect(cursor.ownerOf(p.page)).toBe("s1");
  });

  it("waits for the glide, then puts the arrow back where it was on the next document", async () => {
    const waits: number[] = [];
    const cursor = new AgentCursor({ title: "Codex", sleep: async (ms) => void waits.push(ms) });
    const p = fakePage();
    await cursor.begin(p.page, "s1");
    await cursor.glideTo(p.page, { x: 400, y: 300 });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    const move = p.batches.at(-1)!.find((c) => c.op === "move");
    expect(move).toMatchObject({ x: 400, y: 300 });
    expect((move as { ms: number }).ms).toBe(waits[0]);
    // Every later batch starts by placing the arrow there without a glide.
    await cursor.ring(p.page, { x: 1, y: 2, width: 3, height: 4 });
    expect(p.batches.at(-1)).toContainEqual({ op: "move", key: "s1", x: 400, y: 300, ms: 0 });
  });

  it("does not glide when the page asks for reduced motion", async () => {
    const waits: number[] = [];
    const cursor = new AgentCursor({ title: "Codex", sleep: async (ms) => void waits.push(ms) });
    const p = fakePage({ reducedMotion: true });
    await cursor.begin(p.page, "s1");
    await cursor.glideTo(p.page, { x: 400, y: 300 });
    expect(waits).toEqual([]);
  });

  it("hides the overlay while the model's screenshot is taken, and shows it again even when that fails", async () => {
    const cursor = new AgentCursor({ title: "Codex" });
    const p = fakePage();
    await cursor.begin(p.page, "s1");
    const order: string[] = [];
    await cursor.hiddenDuring(p.page, async () => {
      order.push(...p.ops().slice(-1));
    });
    expect(order).toEqual(["visible"]);
    expect(p.batches.at(-1)).toContainEqual({ op: "visible", on: true });
    await expect(
      cursor.hiddenDuring(p.page, async () => {
        throw new Error("no shot");
      }),
    ).rejects.toThrow("no shot");
    expect(p.batches.at(-1)).toContainEqual({ op: "visible", on: true });
  });

  it("leaves a page it never drew on alone when a screenshot is taken there", async () => {
    const cursor = new AgentCursor({ title: "Codex" });
    const p = fakePage();
    expect(await cursor.hiddenDuring(p.page, async () => "shot")).toBe("shot");
    expect(p.batches).toEqual([]);
  });

  it("tells every page about the live view's pause, and never throws on a closed page", async () => {
    const cursor = new AgentCursor({ title: "Codex" });
    const a = fakePage();
    const b = fakePage();
    b.close();
    await cursor.setPaused([a.page, b.page], true);
    expect(a.batches.at(-1)).toContainEqual({ op: "paused", on: true });
    expect(b.batches).toEqual([]);
    const broken = { isClosed: () => false, evaluate: async () => Promise.reject(new Error("navigated")) };
    await expect(cursor.begin(broken as unknown as Page, "s1")).resolves.toBeUndefined();
  });
});

describe("the cursor setting", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(() => sb.cleanup());

  it("writes identity.json cursor as format 12, checks its value and drops back when removed", () => {
    const on = writeIdentitySettings("school", { cursor: "off" }, sb.env);
    expect(on.version).toBe(12);
    expect(readIdentitySettings("school", sb.env)?.cursor).toBe("off");
    expect(() => writeIdentitySettings("school", { cursor: "maybe" as "on" }, sb.env)).toThrow(
      'cursor must be "auto" (the default, when the browser can be seen), "on" or "off"',
    );
    expect(writeIdentitySettings("school", { cursor: null }, sb.env).version).toBe(1);
  });

  it("keeps camoufox at format 11 and goes to 12 with the cursor", () => {
    expect(writeIdentitySettings("fox", { engine: "camoufox" }, sb.env).version).toBe(11);
    expect(writeIdentitySettings("fox", { cursor: "on" }, sb.env).version).toBe(12);
  });

  it("is auto by default; --cursor wins over identity.json", () => {
    const base = { created: "2026-11-20T00:00:00.000Z", updated: "2026-11-20T00:00:00.000Z" };
    expect(resolveTuning(undefined).cursor).toBe("auto");
    expect(resolveTuning({ ...base, version: 12, cursor: "off" }).cursor).toBe("off");
    expect(resolveTuning({ ...base, version: 12, cursor: "off" }, { cursor: "on" }).cursor).toBe("on");
    expect(extractTuning(["--cursor", "on", "--identity", "x"])).toEqual({
      tuning: { cursor: "on" },
      rest: ["--identity", "x"],
    });
    expect(() => extractTuning(["--cursor=sometimes"])).toThrow('--cursor must be "auto"');
  });
});
