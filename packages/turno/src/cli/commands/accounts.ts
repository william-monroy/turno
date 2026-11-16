import { resolve } from "node:path";
import { readAudit } from "../../accounts/audit.js";
import { launcherExists } from "../../accounts/delegate.js";
import { effectivePolicy } from "../../accounts/policy.js";
import { type Account, type Registry, isValidService, loadRegistry, makeAccount, parseAccountId, saveRegistry } from "../../accounts/registry.js";
import { Journal } from "../../core/journal.js";
import { expandHome, paths, tildify } from "../../core/paths.js";
import { DRY_RUN, type FlagSpec, bool, count, parseFlags, str } from "../args.js";
import { type Command, type Io, fail, paint } from "../io.js";

const USAGE = `Usage:
  turno accounts list                       accounts, owners and folder preferences
  turno accounts add <service:label> --profile <p> --tools <pattern>[,<pattern>]
                       [--read-tools <pattern>[,<pattern>]] [--confirm always|writes|never]
                       [--service <s>] [--description <d>]
  turno accounts remove <service:label>
  turno accounts prefer <path> <service>=<account>   (empty account removes the preference)
  turno accounts log [-n N]                 recent calls to the accounts bridge

The registry lives in ~/.config/turno/accounts.toml. add, remove and prefer rewrite
the file (it is managed: comments in it are not preserved) and accept --dry-run.

A delegated read gets only --read-tools; an account without them has every call confirmed.
--confirm defaults to "always" for mail and messaging services and "writes" elsewhere.`;

/** Flags of each subcommand, shared with completion through flagsOf. */
export const ADD_SPEC: FlagSpec = {
  profile: { type: "string" },
  tools: { type: "string" },
  "read-tools": { type: "string" },
  confirm: { type: "string" },
  service: { type: "string" },
  description: { type: "string" },
  ...DRY_RUN,
};
export const LOG_SPEC: FlagSpec = { tail: { type: "string", short: "n" } };

export function list(io: Io): number {
  const reg = loadRegistry(io.env);
  const accounts = Object.values(reg.accounts).sort((a, b) => a.id.localeCompare(b.id));
  if (!accounts.length) {
    io.out(`No accounts yet. Add one with: turno accounts add linear:work --profile work --tools 'mcp__linear__*'`);
    io.out(`(${tildify(paths(io.env).accountsFile, io.env)})`);
    return 0;
  }
  const width = Math.max(...accounts.map((a) => a.id.length));
  for (const a of accounts) {
    const missing = launcherExists(a.profile, io.env) ? "" : paint(io, "  (no launcher)", "33");
    io.out(`${paint(io, a.id.padEnd(width), "1")}  ${a.profile.padEnd(12)} ${a.tools.join(", ")}${missing}`);
    io.out(`${" ".repeat(width)}  ${paint(io, policyLine(a), "2")}`);
    if (a.description) io.out(`${" ".repeat(width)}  ${paint(io, a.description, "2")}`);
  }
  if (reg.prefer.length) {
    io.out("\nPreferences:");
    for (const r of reg.prefer) {
      const pairs = Object.entries(r.accounts).map(([s, id]) => `${s}=${id}`);
      io.out(`  ${tildify(r.path, io.env)}  ${pairs.join("  ") || "(none)"}`);
    }
  }
  return 0;
}

/** How the bridge treats an account: its confirm policy and what a read may call. */
export function policyLine(a: Account): string {
  const policy = `confirm ${effectivePolicy(a)}${a.confirm ? "" : " (default)"}`;
  if (a.readTools) return `${policy}; reads: ${a.readTools.join(", ")}`;
  return `${policy}; no read_tools: ${effectivePolicy(a) === "never" ? "reads get every tool" : "every call is confirmed"}`;
}

const list_ = (v: string | undefined) =>
  v
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);

export function add(rawArgs: string[], io: Io): number {
  const p = parseFlags(rawArgs, ADD_SPEC);
  const dry = bool(p, "dry-run");
  const [id, extra] = p.positionals;
  if (!id || extra !== undefined) fail("usage: turno identity add <service:label> --profile <p> --tools <pattern>[,<pattern>] [--read-tools <pattern>[,...]] [--confirm always|writes|never]");
  const journal = new Journal(io.env, `accounts add ${id}`, dry);
  const flags = {
    profile: str(p, "profile"),
    tools: str(p, "tools"),
    readTools: str(p, "read-tools"),
    confirm: str(p, "confirm"),
    service: str(p, "service"),
    description: str(p, "description"),
  };
  if (!flags.profile) fail("--profile is required");
  if (!flags.tools) fail("--tools is required");
  const tools = list_(flags.tools);
  const reg = loadRegistry(io.env);
  const existed = Boolean(reg.accounts[id]);
  reg.accounts[id] = makeAccount(id, {
    profile: flags.profile,
    tools,
    ...(flags.readTools !== undefined ? { readTools: list_(flags.readTools) } : {}),
    ...(flags.confirm !== undefined ? { confirm: flags.confirm } : {}),
    ...(flags.service ? { service: flags.service } : {}),
    ...(flags.description ? { description: flags.description } : {}),
  });
  const file = saveRegistry(reg, io.env, journal);
  io.out(`${existed ? "Updated" : "Added"} ${id} (profile ${flags.profile}) in ${tildify(file, io.env)}${dry ? " (dry run)" : ""}.`);
  if (journal.hint()) io.out(journal.hint()!);
  if (!launcherExists(flags.profile, io.env)) io.err(`warning: no launcher claude-${flags.profile} yet; delegation to it will fail until it exists.`);
  return 0;
}

export function remove(rawArgs: string[], io: Io): number {
  const p = parseFlags(rawArgs, DRY_RUN);
  const dry = bool(p, "dry-run");
  const args = p.positionals;
  const journal = new Journal(io.env, `accounts remove ${args.join(" ")}`, dry);
  const [id, extra] = args;
  if (!id || extra !== undefined) fail("usage: turno identity remove <service:label>");
  const reg = loadRegistry(io.env);
  if (!reg.accounts[id]) fail(`unknown account "${id}"`);
  delete reg.accounts[id];
  dropPreferences(reg, id);
  const file = saveRegistry(reg, io.env, journal);
  io.out(`Removed ${id} from ${tildify(file, io.env)}${dry ? " (dry run)" : ""}.`);
  if (journal.hint()) io.out(journal.hint()!);
  return 0;
}

function dropPreferences(reg: Registry, id: string): void {
  for (const r of reg.prefer) {
    for (const [s, target] of Object.entries(r.accounts)) if (target === id) delete r.accounts[s];
  }
  reg.prefer = reg.prefer.filter((r) => Object.keys(r.accounts).length > 0);
}

export function prefer(rawArgs: string[], io: Io): number {
  const p = parseFlags(rawArgs, DRY_RUN);
  const dry = bool(p, "dry-run");
  const args = p.positionals;
  const journal = new Journal(io.env, `accounts prefer ${args.join(" ")}`, dry);
  const [rawPath, pair, extra] = args;
  if (!rawPath || !pair || extra !== undefined) fail("usage: turno identity prefer <path> <service>=<account>");
  const eq = pair.indexOf("=");
  if (eq <= 0) fail("expected <service>=<account>, like linear=linear:work");
  const service = pair.slice(0, eq);
  const accountId = pair.slice(eq + 1);
  if (!isValidService(service)) fail(`invalid service name "${service}"`);
  const reg = loadRegistry(io.env);
  const path = resolve(expandHome(rawPath, io.env));
  let rule = reg.prefer.find((r) => r.path === path);
  if (!accountId) {
    if (rule) delete rule.accounts[service];
    reg.prefer = reg.prefer.filter((r) => Object.keys(r.accounts).length > 0);
    saveRegistry(reg, io.env, journal);
    io.out(`No ${service} preference for ${tildify(path, io.env)} now.`);
    return 0;
  }
  const account = reg.accounts[accountId];
  if (!account) fail(`unknown account "${accountId}"`);
  if (parseAccountId(accountId)?.service !== service) fail(`account "${accountId}" belongs to service "${account.service}", not "${service}"`);
  if (!rule) {
    rule = { path, accounts: {} };
    reg.prefer.push(rule);
  }
  rule.accounts[service] = accountId;
  saveRegistry(reg, io.env, journal);
  io.out(`In ${tildify(path, io.env)}, ${service} prefers ${accountId}${dry ? " (dry run)" : ""}.`);
  if (journal.hint()) io.out(journal.hint()!);
  return 0;
}

export function log(args: string[], io: Io): number {
  const p = parseFlags(args, LOG_SPEC, 0);
  const n = count(p, "tail", 20);
  const entries = readAudit(n, io.env);
  if (!entries.length) {
    io.out("No delegations recorded yet.");
    return 0;
  }
  for (const e of entries) {
    const when = new Date(e.ts).toLocaleString("en-US", { hour12: false });
    const color = e.outcome === "ok" ? "32" : e.outcome === "refused" ? "33" : "31";
    const who = `${e.caller.profile ?? "?"}${e.caller.pid ? `#${e.caller.pid}` : ""}`;
    const cost = e.costUsd === null ? "" : ` $${e.costUsd.toFixed(4)}`;
    const task = e.task.replace(/\s+/g, " ");
    io.out(
      `${when}  ${paint(io, e.outcome.padEnd(7), color)} ${who} -> ${e.account} (${e.owner ?? "?"}) ${e.write ? "write" : "read"} ${Math.round(e.durationMs / 1000)}s${cost}`,
    );
    io.out(`    ${task.length > 120 ? `${task.slice(0, 117)}...` : task}`);
    if (e.decision) {
      const d = e.decision;
      const asked = d.asked ? (d.confirmed ? "confirmed" : "not confirmed") : "not asked";
      const blocked = d.denied?.length ? `; blocked: ${d.denied.join(", ")}` : "";
      io.out(`    ${paint(io, `${d.toolset === "read" ? "read tools" : "all tools"}, ${asked}${d.mcp ? `, ${d.mcp} MCP` : ""}${blocked}`, "2")}`);
    }
    if (e.outcome !== "ok" && e.detail) io.out(`    ${paint(io, e.detail.replace(/\s+/g, " ").slice(0, 160), "2")}`);
  }
  return 0;
}

export const command: Command = {
  summary: "service accounts registry and the delegation bridge log",
  usage: USAGE,
  async run(args, io) {
    const [sub, ...rest] = args;
    switch (sub) {
      case undefined:
      case "list":
        return list(io);
      case "add":
        return add(rest, io);
      case "remove":
      case "rm":
        return remove(rest, io);
      case "prefer":
        return prefer(rest, io);
      case "log":
        return log(rest, io);
      default:
        return fail(`unknown accounts command "${sub}"\n${USAGE}`);
    }
  },
};
