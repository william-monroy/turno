import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Manifest } from "../core/manifest.js";
import { servesProfile } from "../core/manifest.js";

/** Headers every gateway entry carries. The PID and folder are expanded by Claude Code. */
export function gatewayEntry(name: string, port: number, token: string, profile: string): Record<string, unknown> {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Claudio-Profile": profile,
      "X-Claudio-Pid": "${CLAUDIO_SESSION_PID:-0}",
      "X-Claudio-Cwd": "${PWD:-}",
    },
  };
}

/** The mcpServers entries a profile should have, according to the manifest. */
export function profileServers(manifest: Manifest, profile: string, port: number, token: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(manifest.servers)) {
    if (!servesProfile(def, profile)) continue;
    if (def.kind === "remote" && !def.proxy) {
      out[name] = { ...def.entry };
      continue;
    }
    out[name] = gatewayEntry(name, port, token, profile);
  }
  return out;
}

/** Which server names claudio wrote into which config file, so it only ever removes its own. */
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
  /** Entries claudio did not create and leaves alone. */
  foreign: string[];
  /** Foreign entries with the same name as a manifest server: replaced, previous value backed up. */
  replaced: string[];
  changed: boolean;
}

/**
 * Rewrite the mcpServers of one Claude Code config file: add or update manifest entries,
 * remove entries claudio wrote earlier that left the manifest, keep everything else.
 */
export function syncConfigFile(
  configFile: string,
  wanted: Record<string, Record<string, unknown>>,
  previouslyManaged: string[],
  opts: { dryRun?: boolean; backup?: (name: string, entry: unknown) => void } = {},
): SyncResult {
  const cfg = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  const servers = { ...((cfg.mcpServers as Record<string, unknown>) ?? {}) };
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
  if (res.changed && !opts.dryRun) {
    const next = { ...cfg, mcpServers: servers };
    mkdirSync(dirname(configFile), { recursive: true });
    const tmp = `${configFile}.claudio-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, configFile);
  }
  return res;
}
