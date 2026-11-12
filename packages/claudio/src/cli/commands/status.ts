import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import type { Command } from "../io.js";
import { PER_ACCOUNT, SHARED_DIRS, SHARED_FILES } from "./setup.js";
import { type AuthStatus, authStatus } from "./usage.js";

export function accountLine(s: AuthStatus | undefined): string | undefined {
  if (!s?.loggedIn) return undefined;
  const parts = [s.email, s.orgName, s.subscriptionType].filter((v): v is string => Boolean(v)).map(String);
  return parts.length ? parts.join(" · ") : (s.authMethod ?? "logged in");
}

function isLinkTo(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export const command: Command = {
  summary: "show each profile, its account and what it shares",
  usage: "Usage: claudio status",
  async run(_args, io) {
    const p = paths(io.env);
    const profiles = listProfiles(loadConfig(io.env), io.env);
    if (profiles.length === 0) {
      io.out("No profiles. Create one with: claudio setup <profile>");
      return 0;
    }
    const statuses = await Promise.all(profiles.map((name) => authStatus(name, io.env)));
    const shared = [...SHARED_DIRS, ...SHARED_FILES] as string[];
    const known = new Set<string>([...shared, ...PER_ACCOUNT]);
    for (const [i, name] of profiles.entries()) {
      const dir = profileDir(name, io.env);
      io.out(`▸ ${name} (${tildify(dir, io.env)})`);
      if (!existsSync(dir)) {
        io.out(`  ! not set up (claudio setup ${name})`);
        continue;
      }
      io.out(`  account: ${accountLine(statuses[i]) ?? `not logged in (claude-${name} auth login)`}`);
      let ok = 0;
      for (const item of shared) {
        const path = join(dir, item);
        const target = join(p.hub, item);
        if (isLinkTo(path, target)) ok++;
        else if (existsSync(path)) io.out(`  ! ${item} is a local copy, not shared (claudio setup ${name} links it)`);
        else if (existsSync(target)) io.out(`  ! missing link for ${item} (claudio setup ${name})`);
      }
      io.out(`  shared with ${tildify(p.hub, io.env)}: ${ok}`);
      let entries: string[] = [];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        entries = [];
      }
      for (const item of entries) {
        if (known.has(item) || !lexists(join(dir, item))) continue;
        if (/^(\.aside-|\.aparte-|\.claude\.json\.|history\.jsonl\.)/.test(item)) continue;
        io.out(`  ? ${item} is new and unclassified: decide whether to share it`);
      }
    }
    return 0;
  },
};
