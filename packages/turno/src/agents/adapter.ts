import type { Journal } from "../core/journal.js";
import type { AgentId } from "./index.js";

/**
 * How an agent keeps its MCP servers in a config file (ADR 0032). The sync and import code
 * reads and writes a store by its format; it never asks which agent owns the file.
 */
export interface McpStore {
  /** "json": an object under `key`; "toml": `[<key>.<name>]` tables, edited line by line. */
  format: "json" | "toml";
  key: string;
}

export const JSON_MCP_SERVERS: McpStore = { format: "json", key: "mcpServers" };
export const TOML_MCP_SERVERS: McpStore = { format: "toml", key: "mcp_servers" };

/** The gateway URL of one server, the same for every agent. */
export function gatewayUrl(name: string, port: number): string {
  return `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`;
}

/** What an agent's safe mode gets (cli/safe.ts): the MCP file it reads and where it runs. */
export interface SafeStep {
  /** The agent's MCP file: the profile's, or the hub's for the plain agent. */
  file: string;
  /** The folder the agent starts in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A private file the step may write, mode 600 (Claude Code's --mcp-config). */
  scratch: string;
}

/** What safe mode adds to the agent's command line, and lines that say what it did. */
export interface SafePlan {
  args: string[];
  notes: string[];
}

/** Whether an MCP entry points at mcpd: written by `turno mcp sync`, or by hand from `turno mcp config`. */
export function isGatewayEntry(e: unknown): boolean {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  const table = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const headers = { ...table(o.headers), ...table(o.http_headers), ...table(o.env_http_headers) };
  if (Object.keys(headers).some((h) => h.toLowerCase() === "x-turno-profile" || h.toLowerCase() === "x-turno-pid")) return true;
  if (o.bearer_token_env_var === "TURNO_MCPD_TOKEN") return true;
  return typeof o.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[^/]+\/?$/.test(o.url);
}

/** The names of the gateway entries in one server map, sorted. */
export function gatewayNames(map: unknown): string[] {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [];
  return Object.entries(map)
    .filter(([, e]) => isGatewayEntry(e))
    .map(([n]) => n)
    .sort();
}

/** What `ruleFolders` gets: a profile and the folders whose `[[projects]]` rules use it. */
export interface RuleFoldersStep {
  name: string;
  /** The profile's folder. */
  dir: string;
  /** Absolute folders of the rules that name this profile. */
  folders: string[];
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  /** Write a file the step changes, mode 600, through the journal. */
  writeOwn(file: string, text: string): void;
}

/** What an agent's profile setup steps get from `turno profile repair` (cli/commands/setup.ts). */
export interface SetupStep {
  name: string;
  /** The profile's folder. */
  dir: string;
  /** The agent's hub, shared by every profile of the agent. */
  hub: string;
  env: NodeJS.ProcessEnv;
  journal: Journal;
  out(line: string): void;
  /** Write a file the setup creates or changes, mode 600, through the journal. */
  writeOwn(file: string, text: string): void;
  /** True when the profile has live sessions. */
  busy(): boolean;
}

/**
 * One coding agent turno makes profiles for (ADR 0013, ADR 0032). Everything that differs
 * between agents lives here, in one file per agent; the commands read these fields and call
 * these hooks instead of branching on the agent's id.
 */
export interface AgentAdapter {
  id: AgentId;
  /** Product name for messages. */
  label: string;
  /** Program the launcher execs, looked up on PATH. */
  command: string;
  /** Environment variable that moves the agent's whole home. */
  homeEnv: string;
  /** Profile directory name prefix under $HOME: `.claude-` gives ~/.claude-<name>. */
  dirPrefix: string;
  /** Launcher name prefix in ~/.local/bin: `claude-` gives claude-<name>. */
  launcherPrefix: string;
  /** Install hint for doctor and the launcher. */
  install: string;
  /** The subcommand that signs in (`codex login`); without one, the person types /login inside the agent. */
  loginSubcommand?: string;
  /** The agent's own home, shared by every profile of the agent: ~/.claude, ~/.codex, ... */
  hub(env: NodeJS.ProcessEnv): string;
  /** Files that mark a folder as this agent's home (so ~/.cursor-server is not an account). */
  homeMarkers: readonly string[];
  /** Hub folders linked into every profile of this agent. */
  sharedDirs: readonly string[];
  /** Hub files linked into every profile when they exist in the hub. */
  sharedFiles: readonly string[];
  /**
   * Items each profile owns and never shares, and names to ignore (backups the agent writes).
   * Set when the agent's folder layout is known well enough for doctor to flag anything else.
   */
  perAccount?: { items: readonly string[]; ignore: RegExp };
  /** Extra environment of the launcher, as name and value; the launcher generator quotes it. */
  launcherEnv: Readonly<Record<string, string>>;
  /**
   * The launcher keeps the format it had before other agents existed (Claude Code): the header
   * names the shared hub, BROWSER carries a comment, TURNO_AGENT is not exported, and doctor
   * only flags launchers of the bash claudio instead of comparing the whole text.
   */
  classicLauncher: boolean;
  /** The launcher exports TURNO_MCPD_TOKEN, because the agent reads the gateway token from the environment. */
  tokenFromEnv: boolean;
  /** turno can read the signed-in account and its usage windows (`claude auth status`, the status line). */
  accountDetails: boolean;
  mcp: {
    store: McpStore;
    /** The file that holds a profile's MCP entries, given the profile's folder. */
    file(profileDir: string, env: NodeJS.ProcessEnv): string;
    /** True when every profile shares one MCP file (Cursor's ~/.cursor/mcp.json). */
    shared: boolean;
    /** The file the agent reads without a turno launcher: `mcp import` and `doctor --security` read it. */
    hubFile(env: NodeJS.ProcessEnv): string;
    /** A file in the working folder with servers in the same store (Claude Code's .mcp.json). */
    folderFile?: string;
    /** Per-project server maps inside the hub file, by folder (Claude Code's `projects`). */
    projectServers?(config: Record<string, unknown>): [string, unknown][];
    /** Folders the account was used in, from one of its config files (for turno init's rules). */
    foldersUsed?(file: string): string[];
    /** An entry of the agent's own format in Claude Code's shape, for `turno mcp import`. */
    toImport?(entry: Record<string, unknown>): Record<string, unknown>;
    /**
     * Remote servers that do not go through the gateway are written as they are. Agents without
     * it skip them (their formats differ; `turno mcp config` prints them).
     */
    directRemote: boolean;
    /** A gateway entry in the agent's format; `token` is the profile's own token (ADR 0023). */
    gatewayEntry(name: string, port: number, token: string, profile: string): Record<string, unknown>;
    /** A line to print after `turno mcp sync` added servers to the agent's file. */
    afterSync?(added: string[]): string | undefined;
  };
  /**
   * Safe mode (`--no-gateway`, TURNO_SAFE=1): the arguments that leave the gateway entries out of
   * one run, and for Claude Code the status line. The launcher's gateway variables are left out
   * by cli/safe.ts for every agent.
   */
  safeMode(s: SafeStep): SafePlan;
  /**
   * Folder rules use this profile (`turno profile assign`, `turno profile repair`): what the agent
   * needs per folder (Codex: a `[projects]` trust entry). Optional.
   */
  ruleFolders?(s: RuleFoldersStep): void;
  /** Agent steps of `turno profile repair`, around the shared links. */
  setup?: {
    /** Before anything is linked. */
    before?(s: SetupStep): void;
    /** A reason to leave a shared item unlinked for now, printed after the links. */
    hold?(item: string, s: SetupStep): string | undefined;
    /** After the links, before the launcher. */
    after?(s: SetupStep): void;
  };
  /** Warnings about a profile folder, for doctor (each is fixed by `turno profile repair`). */
  doctorWarnings?(dir: string): string[];
}
