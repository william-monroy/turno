import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "smol-toml";
import type { AgentId } from "../agents/index.js";
import type { Manifest } from "../core/manifest.js";
import { servesProfile } from "../core/manifest.js";

/** Headers every gateway entry carries. The PID and folder are expanded by Claude Code. */
export function gatewayEntry(name: string, port: number, token: string, profile: string): Record<string, unknown> {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Turno-Profile": profile,
      "X-Turno-Pid": "${TURNO_SESSION_PID:-0}",
      "X-Turno-Cwd": "${PWD:-}",
    },
  };
}

const gatewayUrl = (name: string, port: number) => `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`;

/**
 * A gateway entry in the format of each agent (ADR 0013). Claude Code gets the token in the
 * entry, as before; the others read it, and the session PID, from the launcher's environment.
 * Cursor shares one file between profiles, so even the profile comes from the environment.
 */
export function gatewayEntryFor(agent: AgentId, name: string, port: number, token: string, profile: string): Record<string, unknown> {
  const url = gatewayUrl(name, port);
  switch (agent) {
    case "claude":
      return gatewayEntry(name, port, token, profile);
    case "codex":
      return {
        url,
        bearer_token_env_var: "TURNO_MCPD_TOKEN",
        http_headers: { "X-Turno-Profile": profile },
        env_http_headers: { "X-Turno-Pid": "TURNO_SESSION_PID", "X-Turno-Cwd": "PWD" },
      };
    case "copilot":
      return {
        type: "http",
        url,
        headers: {
          Authorization: "Bearer ${TURNO_MCPD_TOKEN}",
          "X-Turno-Profile": profile,
          "X-Turno-Pid": "${TURNO_SESSION_PID}",
        },
        tools: ["*"],
      };
    case "cursor":
      return {
        url,
        headers: {
          Authorization: "Bearer ${env:TURNO_MCPD_TOKEN}",
          "X-Turno-Profile": "${env:TURNO_PROFILE}",
          "X-Turno-Pid": "${env:TURNO_SESSION_PID}",
        },
      };
  }
}

/**
 * The MCP entries a profile should have, according to the manifest. Remote servers that do not
 * go through the gateway are written as they are for Claude Code, and skipped for the other
 * agents (their formats differ; `turno mcp config` prints them).
 */
export function profileServers(
  manifest: Manifest,
  profile: string,
  port: number,
  token: string,
  agent: AgentId = "claude",
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(manifest.servers)) {
    if (!servesProfile(def, profile)) continue;
    if (def.kind === "remote" && !def.proxy) {
      if (agent === "claude") out[name] = { ...def.entry };
      continue;
    }
    out[name] = gatewayEntryFor(agent, name, port, token, profile);
  }
  return out;
}

/** Which server names turno wrote into which config file, so it only ever removes its own. */
export type ManagedState = Record<string, string[]>;

export function readManaged(file: string): ManagedState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ManagedState;
  } catch {
    return {};
  }
}

export function writeManaged(file: string, state: ManagedState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export interface SyncResult {
  added: string[];
  updated: string[];
  removed: string[];
  /** Entries turno did not create and leaves alone. */
  foreign: string[];
  /** Foreign entries with the same name as a manifest server: replaced, previous value backed up. */
  replaced: string[];
  changed: boolean;
}

export interface SyncOptions {
  dryRun?: boolean;
  backup?: (name: string, entry: unknown) => void;
}

/** Decide what changes in a server map; mutates `servers`. */
function plan(
  servers: Record<string, unknown>,
  wanted: Record<string, Record<string, unknown>>,
  previouslyManaged: string[],
  opts: SyncOptions,
): SyncResult {
  const res: SyncResult = { added: [], updated: [], removed: [], foreign: [], replaced: [], changed: false };
  const managed = new Set(previouslyManaged);
  for (const name of Object.keys(servers)) {
    if (!(name in wanted) && managed.has(name)) {
      delete servers[name];
      res.removed.push(name);
    } else if (!(name in wanted)) {
      res.foreign.push(name);
    }
  }
  for (const [name, entry] of Object.entries(wanted)) {
    const before = servers[name];
    if (before === undefined) res.added.push(name);
    else if (JSON.stringify(before) !== JSON.stringify(entry)) {
      if (!managed.has(name)) {
        res.replaced.push(name);
        opts.backup?.(name, before);
      }
      res.updated.push(name);
    } else continue;
    servers[name] = entry;
  }
  res.changed = res.added.length + res.updated.length + res.removed.length > 0;
  return res;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.turno-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Rewrite the server map under `key` of a JSON config file (Claude Code `.claude.json`,
 * Copilot `mcp-config.json`, Cursor `mcp.json`): add or update manifest entries, remove
 * entries turno wrote earlier that left the manifest, keep everything else.
 */
export function syncJsonServers(
  configFile: string,
  key: string,
  wanted: Record<string, Record<string, unknown>>,
  previouslyManaged: string[],
  opts: SyncOptions = {},
): SyncResult {
  const cfg = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  const servers = { ...((cfg[key] as Record<string, unknown>) ?? {}) };
  const res = plan(servers, wanted, previouslyManaged, opts);
  if (res.changed && !opts.dryRun) writeAtomic(configFile, `${JSON.stringify({ ...cfg, [key]: servers }, null, 2)}\n`);
  return res;
}

/** The mcpServers of a Claude Code config file. */
export function syncConfigFile(
  configFile: string,
  wanted: Record<string, Record<string, unknown>>,
  previouslyManaged: string[],
  opts: SyncOptions = {},
): SyncResult {
  return syncJsonServers(configFile, "mcpServers", wanted, previouslyManaged, opts);
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k: string) => (BARE_KEY.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  }
  throw new Error(`cannot write ${String(v)} as TOML`);
}

/** Line ranges of every `[mcp_servers.<name>]` table (and its sub-tables) in a TOML text. */
function codexTables(lines: string[]): Map<string, [number, number]> {
  const header = /^\s*\[\s*mcp_servers\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(\.[^\]]*)?\s*\]\s*(#.*)?$/;
  const anyHeader = /^\s*\[/;
  const out = new Map<string, [number, number]>();
  for (let i = 0; i < lines.length; i++) {
    const m = header.exec(lines[i]!);
    if (!m) continue;
    const name = m[1]!.startsWith('"') ? (JSON.parse(m[1]!) as string) : m[1]!;
    let end = i + 1;
    while (end < lines.length && !anyHeader.test(lines[end]!)) end++;
    const prev = out.get(name);
    out.set(name, prev ? [prev[0], end] : [i, end]);
  }
  return out;
}

/**
 * The `[mcp_servers.*]` tables of a Codex config.toml, edited line by line so comments and
 * every other setting stay as they are.
 */
export function syncCodexToml(
  configFile: string,
  wanted: Record<string, Record<string, unknown>>,
  previouslyManaged: string[],
  opts: SyncOptions = {},
): SyncResult {
  const text = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const current = ((parse(text) as Record<string, unknown>).mcp_servers ?? {}) as Record<string, unknown>;
  const servers = { ...current };
  const res = plan(servers, wanted, previouslyManaged, opts);
  if (!res.changed || opts.dryRun) return res;
  let lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  // Drop the tables that go or change, from the bottom up so ranges stay valid.
  const drop = [...res.removed, ...res.updated];
  const ranges = [...codexTables(lines).entries()].filter(([n]) => drop.includes(n)).map(([, r]) => r).sort((a, b) => b[0] - a[0]);
  for (const [start, end] of ranges) lines.splice(start, end - start);
  for (const name of [...res.updated, ...res.added]) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    for (const [k, v] of Object.entries(wanted[name]!)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  lines = lines.length ? lines : [];
  const next = `${lines.join("\n")}\n`;
  parse(next); // never write a file Codex cannot read
  writeAtomic(configFile, next);
  return res;
}
