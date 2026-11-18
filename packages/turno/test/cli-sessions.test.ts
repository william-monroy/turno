import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as sessionsCommand } from "../src/cli/commands/sessions.js";
import { parseConfig } from "../src/core/config.js";
import { busyProfiles, liveSessions, parseProcStart, profileBusy } from "../src/core/sessions.js";
import { fakeIo } from "./helpers/cli.js";
import { killAndWait } from "./helpers/wait.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
function procStartUtc(d: Date): string {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

let sb: Sandbox;
let children: ChildProcess[] = [];
beforeEach(() => {
  sb = sandbox();
  sb.write(".config/turno/config.toml", 'system = "personal"\n');
});
afterEach(async () => {
  // Kill every child even when the test failed early, and wait so none outlives the file.
  await Promise.all(children.map((c) => killAndWait(c)));
  children = [];
  sb.cleanup();
});

function livePid(): number {
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  children.push(c);
  return c.pid!;
}

function session(pid: number, extra: Record<string, unknown> = {}) {
  sb.write(
    `.claude/sessions/${pid}.json`,
    JSON.stringify({
      pid,
      sessionId: `abcdef12-${pid}`,
      cwd: join(sb.home, "code"),
      entrypoint: "cli",
      status: "busy",
      procStart: procStartUtc(new Date()),
      ...extra,
    }),
  );
}

describe("sessions", () => {
  it("parses procStart as UTC and local", () => {
    const r = parseProcStart("Wed Nov 11 00:28:56 2026")!;
    expect(r.utc).toBe(Date.UTC(2026, 10, 11, 0, 28, 56));
    expect(r.local).toBe(new Date(2026, 10, 11, 0, 28, 56).getTime());
    expect(parseProcStart("garbage")).toBeUndefined();
  });

  it("attributes sessions by run record, system profile and desktop", () => {
    const a = livePid();
    const b = livePid();
    const c = livePid();
    const d = livePid();
    session(a, { name: "feature" });
    sb.write(`.local/state/turno/run/${a}`, "work\n");
    session(b);
    sb.write(`.config/claudio/run/${b}`, "lab\n"); // started by a bash launcher
    session(c, { entrypoint: "claude-desktop" });
    session(d);
    const stale = sb.write(`.local/state/turno/run/${d}`, "work\n");
    const old = Date.now() / 1000 - 3600;
    utimesSync(stale, old, old); // a recycled PID: the record predates the process
    session(999_999_9);
    const deadRecord = sb.write(".local/state/turno/run/9999999", "work\n");

    const config = parseConfig('system = "personal"', "x", sb.env);
    const list = liveSessions(sb.env, config);
    const byPid = Object.fromEntries(list.map((s) => [s.pid, s]));
    expect(list).toHaveLength(4);
    expect(byPid[a]).toMatchObject({ profile: "work", source: "record", name: "feature" });
    expect(byPid[b]).toMatchObject({ profile: "lab", source: "record" });
    expect(byPid[c]).toMatchObject({ source: "desktop" });
    expect(byPid[c]!.profile).toBeUndefined();
    expect(byPid[d]).toMatchObject({ profile: "personal", source: "system" });
    expect(existsSync(deadRecord)).toBe(false);

    expect([...busyProfiles(sb.env, config)].sort()).toEqual(["lab", "personal", "work"]);
    expect(profileBusy("work", sb.env, config)).toBe(true);
    expect(profileBusy("other", sb.env, config)).toBe(false);
  });

  it("prints a table", async () => {
    const a = livePid();
    session(a, { name: "feature" });
    sb.write(`.local/state/turno/run/${a}`, "work\n");
    const io = fakeIo(sb.env);
    expect(await sessionsCommand.run([], io)).toBe(0);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^feature\s+work\s+busy\s+\d+s\s+~\/code$/);
  });

  it("says when nothing is alive", async () => {
    const io = fakeIo(sb.env);
    await sessionsCommand.run([], io);
    expect(io.lines).toEqual(["No live sessions."]);
  });
});
