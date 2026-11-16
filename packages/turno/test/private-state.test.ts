import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENESIS, appendAudit, readAudit, verifyAudit } from "../src/accounts/audit.js";
import { saveRegistry } from "../src/accounts/registry.js";
import { command as undo } from "../src/cli/commands/undo.js";
import { Journal, type JournalManifest, listJournals, parseAge, pruneJournals, undoJournal } from "../src/core/journal.js";
import { ensurePrivateDir, findOnPath, paths, resetPrivateDirCache } from "../src/core/paths.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  sb = sandbox();
  resetPrivateDirCache();
});
afterEach(() => sb.cleanup());

const mode = (p: string) => statSync(p).mode & 0o777;

describe("private folders and files", () => {
  it("creates config, state and data roots 0700, leaving their parents alone", () => {
    const p = paths(sb.env);
    ensurePrivateDir(p.logsDir, sb.env);
    ensurePrivateDir(p.config, sb.env);
    ensurePrivateDir(p.serversDir, sb.env);
    for (const dir of [p.state, p.logsDir, p.config, p.data, p.serversDir]) expect(mode(dir), dir).toBe(0o700);
    expect(mode(join(sb.home, ".local", "state"))).toBe(0o755 & ~process.umask());
  });

  it("narrows an existing root the first time it is used", () => {
    const p = paths(sb.env);
    mkdirSync(p.state, { recursive: true });
    chmodSync(p.state, 0o755);
    ensurePrivateDir(p.runDir, sb.env);
    expect(mode(p.state)).toBe(0o700);
  });

  it("follows the XDG variables and the TURNO_*_DIR overrides", () => {
    const env = { ...sb.env, XDG_STATE_HOME: join(sb.home, "xdg-state"), TURNO_CONFIG_DIR: join(sb.home, "cfg") };
    ensurePrivateDir(paths(env).backupsDir, env);
    ensurePrivateDir(paths(env).config, env);
    expect(mode(join(sb.home, "xdg-state", "turno"))).toBe(0o700);
    expect(mode(join(sb.home, "cfg"))).toBe(0o700);
  });

  it("creates other folders with the default mode", () => {
    const dir = join(sb.home, "elsewhere", "x");
    ensurePrivateDir(dir, sb.env);
    expect(mode(dir)).toBe(0o777 & ~process.umask());
  });

  it("writes accounts.toml 0600", () => {
    const file = saveRegistry({ accounts: {}, prefer: [] }, sb.env);
    expect(mode(file)).toBe(0o600);
    expect(mode(paths(sb.env).config)).toBe(0o700);
  });

  it("journaled writes of turno's own files are 0600, other files keep their mode", () => {
    const p = paths(sb.env);
    sb.write(".config/turno/config.toml", "a = 1\n", 0o644);
    const settings = sb.write(".claude/settings.json", "{}", 0o644);
    const j = new Journal(sb.env, "test");
    j.write(p.configFile, "a = 2\n");
    j.write(p.mcpFile, "");
    j.write(settings, '{"x":1}');
    expect(mode(p.configFile)).toBe(0o600);
    expect(mode(p.mcpFile)).toBe(0o600);
    expect(mode(settings)).toBe(0o644);
  });

  it("finds executables on the PATH of the given env only", () => {
    const fake = fakeCommand(sb, "turno-fake-tool", "exit 0");
    expect(findOnPath("turno-fake-tool", sb.env)).toBe(fake);
    expect(findOnPath("turno-fake-tool", { PATH: "/nonexistent" })).toBeUndefined();
  });
});

describe("journal backups", () => {
  it("keeps copies 0600 inside 0700 folders", () => {
    const secret = sb.write(".claude.json", '{"token":"literal"}', 0o644);
    const j = new Journal(sb.env, "mcp sync");
    j.write(secret, "{}");
    const files = join(j.dir, "files");
    expect(mode(paths(sb.env).backupsDir)).toBe(0o700);
    expect(mode(j.dir)).toBe(0o700);
    expect(mode(files)).toBe(0o700);
    expect(mode(join(files, readdirSync(files)[0]!))).toBe(0o600);
    expect(mode(join(j.dir, "journal.json"))).toBe(0o600);
  });

  /** A backup folder `daysAgo` old that changed `file` (wrote = what it holds now, if live). */
  function oldJournal(n: number, daysAgo: number, entry?: { path: string; wrote: string }, year = "2020"): string {
    const created = new Date(Date.now() - daysAgo * DAY);
    const stamp = `${year}010${Math.floor(n / 10)}-00000${n % 10}`;
    const dir = join(paths(sb.env).backupsDir, stamp);
    mkdirSync(join(dir, "files"), { recursive: true });
    const m: JournalManifest = { version: 1, stamp, command: `old ${n}`, created: created.toISOString(), entries: entry ? [{ path: entry.path, existed: false, wrote: entry.wrote }] : [] };
    writeFileSync(join(dir, "journal.json"), JSON.stringify(m));
    return stamp;
  }

  it("prunes backups older than the cutoff but keeps the newest N", () => {
    const stamps = Array.from({ length: 14 }, (_, i) => oldJournal(i, 40 + (14 - i)));
    const dry = pruneJournals(sb.env, { dryRun: true });
    expect(dry.pruned).toEqual(stamps.slice(0, 4).reverse());
    expect(listJournals(sb.env)).toHaveLength(14);
    const r = pruneJournals(sb.env);
    expect(r.pruned).toHaveLength(4);
    expect(listJournals(sb.env).map((j) => j.stamp)).toEqual(stamps.slice(4).reverse());
    expect(pruneJournals(sb.env, { keep: 0, olderThanMs: 60 * DAY }).pruned).toEqual([]);
    expect(pruneJournals(sb.env, { keep: 0 }).pruned).toHaveLength(10);
  });

  it("never prunes a backup that is still the only way back for a file", () => {
    const file = sb.write("note.txt", "now");
    const live = oldJournal(0, 90, { path: file, wrote: createHash("sha256").update("now").digest("hex") });
    const stale = oldJournal(1, 80, { path: file, wrote: "something else" });
    const r = pruneJournals(sb.env, { keep: 0 });
    expect(r.pruned).toEqual([stale]);
    expect(r.kept).toEqual([{ stamp: live, path: file }]);
  });

  it("prunes automatically when a new backup is written", () => {
    for (let i = 0; i < 12; i++) oldJournal(i, 40 + i);
    const target = sb.write("x.txt", "1");
    const j = new Journal(sb.env, "new");
    j.write(target, "2");
    const left = listJournals(sb.env).map((x) => x.stamp);
    expect(left).toHaveLength(10);
    expect(left[0]).toBe(j.stamp);
  });

  it("an undo keeps the journal it reads from even when it is old", () => {
    const a = sb.write("a.txt", "old a");
    const b = sb.write("b.txt", "old b");
    const j = new Journal(sb.env, "change");
    j.write(a, "new a");
    j.write(b, "new b");
    // Age the journal and change both files again, so it is no longer live.
    const info = listJournals(sb.env)[0]!;
    info.manifest!.created = new Date(Date.now() - 400 * DAY).toISOString();
    writeFileSync(join(info.dir, "journal.json"), JSON.stringify(info.manifest));
    // Ten newer stamps push it out of the kept set, so only the undo's protection saves it.
    for (let i = 0; i < 11; i++) oldJournal(i, 300, undefined, "2099");
    writeFileSync(a, "later a");
    writeFileSync(b, "later b");
    const r = undoJournal(listJournals(sb.env).find((x) => x.stamp === j.stamp)!, sb.env, { force: true });
    expect(r.steps.map((s) => s.action)).toEqual(["restore", "restore"]);
    expect(readFileSync(a, "utf8")).toBe("old a");
    expect(readFileSync(b, "utf8")).toBe("old b");
  });

  it("parses ages", () => {
    expect(parseAge("30d")).toBe(30 * DAY);
    expect(parseAge("2w")).toBe(14 * DAY);
    expect(parseAge("12h")).toBe(DAY / 2);
    expect(parseAge("7")).toBe(7 * DAY);
    expect(() => parseAge("soon")).toThrow(/invalid age/);
  });

  it("turno undo --prune", async () => {
    for (let i = 0; i < 12; i++) oldJournal(i, 40 + i);
    const io = fakeIo(sb.env);
    expect(await undo.run(["--prune", "--dry-run"], io)).toBe(0);
    expect(io.lines[0]).toMatch(/^would delete 2 backups: /);
    expect(listJournals(sb.env)).toHaveLength(12);
    const json = fakeIo(sb.env);
    expect(await undo.run(["--prune", "--older-than", "45d", "--keep", "0", "--json"], json)).toBe(0);
    expect(JSON.parse(json.lines.join("\n")).pruned).toHaveLength(7);
    await expect(undo.run(["--prune", "--older-than", "soon"], fakeIo(sb.env))).rejects.toThrow(/invalid age/);
    await expect(undo.run(["--older-than", "3d"], fakeIo(sb.env))).rejects.toThrow(/go with --prune/);
  });
});

describe("audit log", () => {
  const base = { caller: { profile: "personal", pid: 42 }, account: "linear:work", owner: "work", write: false, outcome: "ok" as const, detail: "", durationMs: 5, costUsd: null };

  it("chains each line to the previous one and verifies", () => {
    for (const task of ["one", "two", "three"]) appendAudit({ ...base, task }, sb.env);
    const all = readAudit(0, sb.env);
    expect(all[0]?.prev).toBe(GENESIS);
    expect(all[1]?.prev).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAudit(sb.env)).toEqual({ ok: true, lines: 3, legacy: 0 });
  });

  it("detects an edited, a removed and a hand-added line", () => {
    const file = paths(sb.env).auditLog;
    for (const task of ["one", "two", "three"]) appendAudit({ ...base, task }, sb.env);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace('"task":"two"', '"task":"TWO"'));
    expect(verifyAudit(sb.env)).toMatchObject({ ok: false, line: 3 });
    const lines = original.trimEnd().split("\n");
    writeFileSync(file, `${[lines[0], lines[2]].join("\n")}\n`);
    expect(verifyAudit(sb.env)).toMatchObject({ ok: false, line: 2 });
    writeFileSync(file, `${lines.slice(1).join("\n")}\n`);
    expect(verifyAudit(sb.env)).toMatchObject({ ok: false, line: 1, reason: expect.stringMatching(/removed from the start/) });
    writeFileSync(file, original);
    appendFileSync(file, `${JSON.stringify({ ...base, ts: "x", task: "forged" })}\n`);
    expect(verifyAudit(sb.env)).toMatchObject({ ok: false, line: 4 });
  });

  it("continues a log written before the chain existed", () => {
    const file = paths(sb.env).auditLog;
    mkdirSync(paths(sb.env).state, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...base, ts: "t", task: "legacy" })}\n`, { mode: 0o644 });
    appendAudit({ ...base, task: "new" }, sb.env);
    expect(mode(file)).toBe(0o600);
    expect(mode(paths(sb.env).state)).toBe(0o700);
    expect(verifyAudit(sb.env)).toEqual({ ok: true, lines: 2, legacy: 1 });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("verifies an empty or missing log", () => {
    expect(verifyAudit(sb.env)).toEqual({ ok: true, lines: 0, legacy: 0 });
  });
});
