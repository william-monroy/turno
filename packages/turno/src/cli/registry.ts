import type { Command } from "./io.js";

type Loader = () => Promise<{ command: Command }>;

/**
 * Every command, loaded lazily so hot paths (`auto`, `resolve`, `statusline`) never pay for
 * the MCP SDK. Order and section decide `turno help`.
 */
export const SECTIONS: { title: string; commands: string[] }[] = [
  { title: "Start an agent", commands: ["run", "auto"] },
  { title: "Accounts", commands: ["profile", "limit", "session", "open"] },
  { title: "MCP servers and outside services", commands: ["mcp", "identity", "secret"] },
  { title: "Look", commands: ["ui"] },
  { title: "Maintenance", commands: ["status", "doctor", "config", "undo", "upgrade", "version", "completion"] },
  { title: "Developer tools", commands: ["browser"] },
];

/** Help summaries set here instead of by the command module. */
export const HELP_SUMMARY: Record<string, string> = {
  browser: "developer tool: compare browser engines (needs turno-browser)",
};

export const COMMANDS: Record<string, Loader> = {
  run: () => import("./commands/run.js"),
  auto: () => import("./commands/auto.js"),
  profile: () => import("./commands/profile.js"),
  limit: () => import("./commands/limit.js"),
  session: () => import("./commands/session.js"),
  open: () => import("./commands/open.js"),
  mcp: () => import("./commands/mcp.js"),
  identity: () => import("./commands/identity.js"),
  secret: () => import("./commands/secret.js"),
  browser: () => import("./commands/browser.js"),
  ui: () => import("./commands/ui.js"),
  status: () => import("./commands/status.js"),
  doctor: () => import("./commands/doctor.js"),
  config: () => import("./commands/config.js"),
  undo: () => import("./commands/undo.js"),
  upgrade: () => import("./commands/upgrade.js"),
  version: () => import("./commands/version.js"),
  completion: () => import("./commands/completion.js"),
  // Kept for people coming from the bash tool; not in the help.
  migrate: () => import("./commands/migrate.js"),
  // Called by Claude Code, hooks, launchers and the LaunchAgent; not in the help.
  statusline: () => import("./commands/statusline.js"),
  hook: () => import("./commands/hook.js"),
  resolve: () => import("./commands/resolve.js"),
  mcpd: () => import("./commands/mcpd.js"),
  __complete: () => import("./commands/complete.js"),
  "__update-check": () => import("./commands/update-check.js"),
};

/**
 * Earlier names: the 0.1 commands and the Spanish words of the bash script. They keep
 * working so hooks, editors, skills and muscle memory do not break; the help shows the new ones.
 */
export const ALIASES: Record<string, string[]> = {
  which: ["profile", "which"],
  setup: ["profile", "repair"],
  sessions: ["session", "list"],
  handoff: ["session", "handoff"],
  usage: ["limit", "show"],
  exhausted: ["limit", "set"],
  available: ["limit", "clear"],
  accounts: ["identity"],
  cuenta: ["profile", "which"],
  resolver: ["resolve"],
  sesiones: ["session", "list"],
  uso: ["limit", "show"],
  agotada: ["limit", "set"],
  disponible: ["limit", "clear"],
  limite: ["hook", "rate-limit"],
  abrir: ["open"],
  "sync-mcp": ["mcp", "sync"],
};

export const ALIAS_FLAGS: Record<string, Record<string, string>> = {
  uso: { "--vigilar": "--watch" },
  agotada: { hasta: "until" },
};

/** Commands that run on every prompt or launch: no update notice, no extra work. */
export const QUIET = new Set(["run", "auto", "open", "statusline", "hook", "resolve", "mcpd", "__complete", "__update-check", "completion", "upgrade", "version"]);

/** Expand an alias: the command name and the arguments it stands for. */
export function expand(first: string, rest: string[]): [string, string[]] {
  const alias = ALIASES[first];
  if (!alias) return [first, rest];
  const flags = ALIAS_FLAGS[first] ?? {};
  return [alias[0]!, [...alias.slice(1), ...rest.map((a) => flags[a] ?? a)]];
}

/** Every visible command name, for suggestions after a typo. */
export function visibleCommands(): string[] {
  return SECTIONS.flatMap((s) => s.commands);
}
