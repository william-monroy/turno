import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAudit, verifyAudit } from "../src/accounts/audit.js";
import { main } from "../src/cli/main.js";
import { listJournals } from "../src/core/journal.js";
import { paths } from "../src/core/paths.js";
import { StateError, hasFields, isStringArray, parseState, readState, readStateResult, recordOf, requireState } from "../src/core/state-file.js";
import { availableUpdate } from "../src/core/update.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { readLock, readStartError } from "../src/mcpd/state.js";
import { peekManaged, readManaged } from "../src/mcpd/sync.js";
import { readSyncedTokenProfiles } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const isNamed = (v: unknown): v is { name: string } => hasFields(v, { name: "string" });

describe("readState (ADR 0045)", () => {
  it("returns the value, or says why it cannot", () => {
    const file = sb.write("s.json", '{"name":"a"}');
    expect(readState(file, isNamed)).toEqual({ name: "a" });
    expect(readStateResult(join(sb.home, "none.json"), isNamed)).toMatchObject({ ok: false, problem: "missing" });
    sb.write("cut.json", '{"name":');
    expect(readStateResult(join(sb.home, "cut.json"), isNamed)).toMatchObject({ ok: false, problem: "corrupt" });
    sb.write("other.json", '{"name":3}');
    expect(readStateResult(join(sb.home, "other.json"), isNamed)).toMatchObject({ ok: false, problem: "shape" });
    expect(readState(join(sb.home, "other.json"), isNamed)).toBeUndefined();
  });

  it("reads files without a version as format 1 and refuses a newer format", () => {
    const old = sb.write("old.json", '{"name":"a"}');
    expect(readState(old, isNamed, 1)).toEqual({ name: "a" });
    const v2 = sb.write("v2.json", '{"version":2,"name":"a"}');
    expect(readState(v2, isNamed, 2)).toEqual({ version: 2, name: "a" });
    const r = readStateResult(v2, isNamed, 1);
    expect(r).toMatchObject({ ok: false, problem: "newer" });
    expect(!r.ok && r.message).toContain("from a newer turno");
  });

  it("requireState: undefined when missing, a one-line StateError naming the file otherwise", () => {
    expect(requireState(join(sb.home, "none.json"), isNamed)).toBeUndefined();
    const bad = sb.write("bad.json", "[1,2");
    expect(() => requireState(bad, isNamed)).toThrow(StateError);
    expect(() => requireState(bad, isNamed)).toThrow(`${bad} is not valid JSON; fix it by hand or remove it`);
    const newer = sb.write("newer.json", '{"version":9,"name":"a"}');
    expect(() => requireState(newer, isNamed)).toThrow(/upgrade turno/);
  });

  it("small guards", () => {
    expect(isStringArray(["a"])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(recordOf(isStringArray)({ f: ["a"] })).toBe(true);
    expect(recordOf(isStringArray)({ f: "a" })).toBe(false);
    expect(parseState("{}", isNamed, 1, "line")).toMatchObject({ ok: false, problem: "shape", message: "line does not hold what turno expects" });
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable file is not a missing one", () => {
    const file = sb.write("locked.json", '{"name":"a"}');
    chmodSync(file, 0o000);
    try {
      expect(readStateResult(file, isNamed)).toMatchObject({ ok: false, problem: "unreadable" });
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("turno's state files, corrupt or of another shape", () => {
  const state = (rel: string, text: string) => sb.write(`.local/state/turno/${rel}`, text);

  it("caches and hints read as absent instead of crashing", () => {
    for (const text of ["", "{", "null", "[]", '"x"', '{"pid":"12"}', '{"pid":-1}']) {
      state("mcpd.lock", text);
      expect(readLock(sb.env), text).toBeUndefined();
    }
    state("mcpd.error.json", '{"at":1}');
    expect(readStartError(sb.env)).toBeUndefined();
    state("update.json", '{"latest":"99.0.0"}');
    expect(availableUpdate(sb.env)).toBeUndefined();
    state("update.json", '{"checkedAt":1,"channel":"latest","latest":"99.0.0"}');
    expect(availableUpdate(sb.env)).toBe("99.0.0");
    state("mcpd.lock", '{"pid":4242,"port":47821,"startedAt":"x"}');
    expect(readLock(sb.env)?.pid).toBe(4242);
  });

  it("the server description cache skips a file of another shape", () => {
    const dir = join(sb.home, "cache");
    mkdirSync(dir);
    sb.write("cache/gh.json", '{"fingerprint":"f","tools":"oops"}');
    expect(new DescriptionCache(dir).peek("gh")).toBeUndefined();
    sb.write("cache/gh.json", '{"fingerprint":"f","serverInfo":{},"capabilities":{},"updatedAt":1}');
    expect(new DescriptionCache(dir).get("gh", "f")?.fingerprint).toBe("f");
  });

  it("mcp-managed.json that cannot be read stops mcp sync with a clear error, and doctor reads past it", async () => {
    const file = paths(sb.env).mcpdManaged;
    sb.write(file.slice(sb.home.length + 1), '{"a.json":"not a list"}');
    expect(() => readManaged(file)).toThrow(StateError);
    expect(() => readManaged(file)).toThrow(/does not hold what turno expects; fix it by hand or remove it/);
    expect(peekManaged(file)).toEqual({});
    sb.write(".config/turno/mcp.toml", '[server.calc]\ncommand = "calc"\n');
    const io = fakeIo(sb.env);
    expect(await main(["mcp", "sync", "--dry-run"], io)).toBe(1);
    expect(io.errors.join("\n")).toMatch(/^turno: .*mcp-managed\.json does not hold what turno expects; fix it by hand or remove it$/);
    expect(io.errors.join("\n")).not.toContain("    at ");
  });

  it("the synced token list keeps its strings", () => {
    const tokens = join(sb.home, ".local/state/turno/mcpd-tokens");
    mkdirSync(tokens, { recursive: true });
    sb.write(".local/state/turno/mcpd-tokens/synced.json", '["work",3,"personal"]');
    expect(readSyncedTokenProfiles(sb.env)).toEqual(["work", "personal"]);
    sb.write(".local/state/turno/mcpd-tokens/synced.json", '{"work":true}');
    expect(readSyncedTokenProfiles(sb.env)).toEqual([]);
  });

  it("a journal manifest of another shape lists the backup as restore-by-hand", () => {
    state("backups/20261117-100000/journal.json", '{"version":1,"stamp":"x"}');
    state("backups/20261117-110000/journal.json", '{"version":1,"stamp":"20261117-110000","command":"init","created":"t","entries":[{"path":"/x"}]}');
    state("backups/20261117-120000/journal.json", '{"version":2,"stamp":"20261117-120000","command":"init","created":"t","entries":[]}');
    const all = listJournals(sb.env);
    expect(all.map((j) => [j.stamp, Boolean(j.manifest)])).toEqual([
      ["20261117-120000", false],
      ["20261117-110000", true],
      ["20261117-100000", false],
    ]);
  });

  it("audit lines of another shape are skipped by log and reported by --verify", () => {
    const good = '{"ts":"t","caller":{"profile":null,"pid":null},"account":"a","owner":null,"write":false,"task":"x","outcome":"ok","detail":"","durationMs":1,"costUsd":null}';
    const file = paths(sb.env).auditLog;
    sb.write(file.slice(sb.home.length + 1), `${good}\n{"ts":"t"}\n`);
    expect(readAudit(0, sb.env)).toHaveLength(1);
    expect(verifyAudit(sb.env)).toMatchObject({ ok: false, line: 2, reason: "not an audit entry" });
    expect(readFileSync(file, "utf8")).toContain('{"ts":"t"}');
  });
});
