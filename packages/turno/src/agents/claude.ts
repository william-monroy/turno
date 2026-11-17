import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, tildify } from "../core/paths.js";
import { plural } from "../cli/io.js";
import { type AgentAdapter, JSON_MCP_SERVERS, type SetupStep, gatewayUrl } from "./adapter.js";

/**
 * Hub folders shared by every Claude Code profile. Launchers recreate them, so a cleanup that
 * removed an empty hub folder never leaves a profile with a dangling symlink.
 */
export const SHARED_DIRS = [
  "projects",
  "file-history",
  "plans",
  "tasks",
  "paste-cache",
  "session-env",
  "uploads",
  "dev-mods",
  "sessions",
  "skills",
  "commands",
  "agents",
  "hooks",
  "plugins",
  "output-styles",
  "workflows",
  "agent-memory",
  "rules",
  "themes",
  "state",
  "usage-data",
  "cache",
] as const;

/** Hub files shared by every profile (linked only when they exist in the hub). */
export const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "statusline-command.sh", ".mcp.json"] as const;

/**
 * Owned by each account and never linked. history.jsonl cannot be a symlink: Claude Code
 * ignores it unless it is a regular file with a single link.
 */
export const PER_ACCOUNT = [
  ".claude.json",
  ".credentials.json",
  "history.jsonl",
  "backups",
  "daemon",
  "daemon.log",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  "daemon.lock",
  "daemon.status.json",
  "feedback",
  "jobs",
  "policy-limits.json",
  "policy-limits.json.stamp.json",
  "policy-limits.json.signature.json",
  "remote-settings.json",
  "remote-settings.json.signature.json",
  "remote-settings.json.synced-at",
  "mcp-needs-auth-cache.json",
  "stats-cache.json",
  "telemetry",
  "shell-snapshots",
  "debug",
  ".last-cleanup",
  ".last-update-result.json",
  "computer-use.lock",
] as const;

/**
 * Headers every Claude Code gateway entry carries. The PID and folder are expanded by Claude
 * Code from the launcher's environment. The folder travels base64url-encoded: a raw path outside
 * Latin-1 (accents in NFD form, CJK, emoji) is an invalid header value and the client would
 * refuse to connect. Without the variable (a plain `claude`), mcpd reads the folder of the
 * client process.
 */
export function gatewayEntry(name: string, port: number, token: string, profile: string): Record<string, unknown> {
  return {
    type: "http",
    url: gatewayUrl(name, port),
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Turno-Profile": profile,
      "X-Turno-Pid": "${TURNO_SESSION_PID:-0}",
      "X-Turno-Cwd-B64": "${TURNO_SESSION_CWD_B64:-}",
    },
  };
}

const SEED_KEYS = ["mcpServers", "projects", "hasCompletedOnboarding", "lastOnboardingVersion", "theme"];

/** First .claude.json of a profile: user MCP servers and per-project state, never the account. */
function seedGlobalConfig(s: SetupStep): void {
  const dst = join(s.dir, ".claude.json");
  if (existsSync(dst)) {
    s.out("  = .claude.json already exists (turno mcp sync brings in new MCP servers)");
    return;
  }
  const src = paths(s.env).hubConfig;
  let hub: Record<string, unknown>;
  try {
    hub = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const seed: Record<string, unknown> = {};
  for (const k of SEED_KEYS) if (k in hub) seed[k] = hub[k];
  s.writeOwn(dst, `${JSON.stringify(seed, null, 2)}\n`);
  const count = (v: unknown) => (v && typeof v === "object" ? Object.keys(v).length : 0);
  s.out(`  + .claude.json with ${plural(count(seed.mcpServers), "MCP server")} and ${plural(count(seed.projects), "project")} from the hub`);
}

/** The ↑ history starts as a copy of the hub's: it cannot be shared (see PER_ACCOUNT). */
function copyHistory(s: SetupStep): void {
  const history = join(s.dir, "history.jsonl");
  const hubHistory = join(s.hub, "history.jsonl");
  if (existsSync(history) || !isFile(hubHistory)) return;
  s.journal.save(history);
  copyFileSync(hubHistory, history);
  chmodSync(history, 0o600);
  s.journal.settle(history);
  s.out("  + history.jsonl (initial copy; the ↑ history cannot be shared)");
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The `projects` of a Claude Code config: per-folder state, MCP servers among it. */
function projectsOf(file: string): string[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { projects?: unknown };
    return v.projects && typeof v.projects === "object" && !Array.isArray(v.projects) ? Object.keys(v.projects) : [];
  } catch {
    return [];
  }
}

export const claude: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  homeEnv: "CLAUDE_CONFIG_DIR",
  dirPrefix: ".claude-",
  launcherPrefix: "claude-",
  install: "https://docs.claude.com/claude-code",
  hub: (env) => paths(env).hub,
  homeMarkers: [".claude.json", ".credentials.json", "settings.json", "projects", "history.jsonl"],
  sharedDirs: SHARED_DIRS,
  sharedFiles: SHARED_FILES,
  perAccount: { items: PER_ACCOUNT, ignore: /^(\.aside-|\.aparte-|\.claude\.json\.|history\.jsonl\.)/ },
  launcherEnv: {},
  classicLauncher: true,
  tokenFromEnv: false,
  accountDetails: true,
  mcp: {
    store: JSON_MCP_SERVERS,
    file: (dir) => join(dir, ".claude.json"),
    shared: false,
    hubFile: (env) => paths(env).hubConfig,
    folderFile: ".mcp.json",
    projectServers: (config) =>
      Object.entries((config.projects as Record<string, Record<string, unknown>>) ?? {}).map(([dir, proj]) => [dir, proj?.mcpServers]),
    foldersUsed: projectsOf,
    directRemote: true,
    gatewayEntry,
  },
  setup: {
    before(s) {
      if (existsSync(s.hub)) return;
      // Claude Code creates it on first run; profiles need it now to link the shared folders.
      mkdirSync(s.hub, { recursive: true, mode: 0o700 });
      s.out(`  + created ${tildify(s.hub, s.env)} (the folder every Claude Code profile shares)`);
    },
    hold(item, s) {
      // Claude Code keeps live session files there: replacing the folder under an open session loses them.
      if (item === "sessions" && !isSymlink(join(s.dir, item)) && s.busy()) {
        return "sessions: this profile has open sessions; close them and run turno profile repair again";
      }
      return undefined;
    },
    after(s) {
      seedGlobalConfig(s);
      copyHistory(s);
    },
  },
};
