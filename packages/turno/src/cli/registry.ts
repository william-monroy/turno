import type { Command } from "./io.js";

type Loader = () => Promise<{ command: Command }>;

/**
 * Every command, loaded lazily so hot paths (`auto`, `resolve`, `statusline`) never pay for
 * the MCP SDK. Order and section decide `turno help`.
 */
export const SECTIONS: { title: string; commands: string[] }[] = [
  { title: "Get started", commands: ["init", "demo"] },
  { title: "Start an agent", commands: ["run", "auto"] },
  { title: "Accounts", commands: ["profile", "limit", "session", "open"] },
  { title: "MCP servers and outside services", commands: ["mcp", "identity", "secret"] },
  { title: "Look", commands: ["ui"] },
  {
    title: "Maintenance",
    commands: ["status", "doctor", "config", "undo", "upgrade", "uninstall", "version", "completion"],
  },
  { title: "Developer tools", commands: ["browser"] },
];

/**
 * One line per visible command for `turno help`, so the help renders from this table without
 * loading any command module. Each must equal the command's own `summary` (a test checks it).
 */
export const HELP_SUMMARY: Record<string, string> = {
  init: "set turno up in one step: find agents, profiles, folders and MCP servers, show the diff, write it (one undo)",
  demo: "try turno in a throwaway HOME: two profiles, a gateway and the status line (removed on exit)",
  run: "open a profile with its agent (turno <profile> is the short form), or auto",
  auto: "open the agent with the account assigned to this folder (turno-auto)",
  profile: "accounts (profiles) for each agent: list, add, repair, remove, and which folders use each",
  limit: "usage limits of each account, and the exhausted marks that move projects to the fallback",
  session: "live Claude Code sessions, and moving one to another account",
  open: "open a claude.ai link with an account (default: the session's)",
  mcp: "MCP servers behind the lazy gateway, and the gateway daemon itself",
  identity: "who acts on outside services: service accounts (linear:work) and browser identities (browser:school)",
  secret: "store MCP secrets in the Keychain (macOS) or the Secret Service (Linux)",
  ui: "the status line, its font and icons in every terminal",
  status: "one screen with everything: this folder, profiles and usage, sessions, mcpd and the look",
  doctor: "check everything (system, config, profiles, MCP, look, mcpd) and fix what is safe to fix",
  config: "read and change config.toml without losing its comments; check every config file",
  undo: "list recent changes turno made to your files, and put any of them back",
  upgrade: "update turno to the newest release (or check for one)",
  uninstall: "remove the service, launchers, status line and MCP entries turno set up (profile folders stay)",
  version: "the turno version, how it was installed, and whether a newer one is known",
  completion: "shell completion for commands, profiles, identities and config keys",
  browser: "developer tool: compare browser engines (needs turno-browser)",
};

/** `turno help <topic>` (cli/topics.ts), listed here so `turno help` loads nothing. */
export const HELP_TOPICS: readonly string[] = ["environment", "exit-codes", "json"];

export const COMMANDS: Record<string, Loader> = {
  init: () => import("./commands/init.js"),
  demo: () => import("./commands/demo.js"),
  run: () => import("./commands/run.js"),
  auto: () => import("./commands/auto.js"),
  profile: () => import("./commands/profile.js"),
  limit: () => import("./commands/limit.js"),
  session: () => import("./commands/session.js"),
  open: () => import("./commands/open.js"),
  mcp: () => import("./commands/mcp.js"),
  // Described by turno-browser when it is installed (the browser flags in help and completion).
  identity: async () => ({ command: await (await import("./commands/identity.js")).loadCommand() }),
  secret: () => import("./commands/secret.js"),
  browser: async () => ({ command: await (await import("./commands/browser.js")).loadCommand() }),
  ui: () => import("./commands/ui.js"),
  status: () => import("./commands/status.js"),
  doctor: () => import("./commands/doctor.js"),
  config: () => import("./commands/config.js"),
  undo: () => import("./commands/undo.js"),
  upgrade: () => import("./commands/upgrade.js"),
  uninstall: () => import("./commands/uninstall.js"),
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
const ALIASES: Record<string, string[]> = {
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

const ALIAS_FLAGS: Record<string, Record<string, string>> = {
  uso: { "--vigilar": "--watch" },
  agotada: { hasta: "until" },
};

/** Commands that run on every prompt or launch: no update notice, no extra work. */
export const QUIET = new Set([
  "run",
  "auto",
  "open",
  "statusline",
  "hook",
  "resolve",
  "mcpd",
  "__complete",
  "__update-check",
  "completion",
  "upgrade",
  "version",
]);

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
