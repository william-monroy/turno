import { spawn } from "node:child_process";
import type { Io } from "turno-core/cli";
import type { BrowserFunctions } from "../api.js";
import type { ServedIdentity } from "../doctor.js";
import type { SettingsPatch } from "../settings.js";
import { type CliNames, STANDALONE_NAMES } from "../names.js";
import type { DoTransport } from "./do.js";
import { type BackgroundDoDeps, backgroundTransport, defaultBackgroundDoDeps } from "./do-background.js";

/**
 * What the identity commands need from the program that runs them. They run as `turno-browser
 * <cmd>` on their own, and as `turno browser <cmd>` and `turno identity ... browser:<id>` inside
 * turno-cli, which passes a host of its own for what only turno has: the mcp.toml block, the
 * gateway that `do` goes through, and its own command names in hints and help.
 */

export type { CliNames } from "../names.js";

export interface BrowserCliHost {
  names: CliNames;
  /** The paragraph after the subcommands in the group's help. */
  footer: string;
  /** The summary of `add` in the help: what it prints once the identity exists. */
  addSummary: string;
  /** What `add` prints once the identity exists: how an agent reaches it. */
  connect(id: string, settings: SettingsPatch, io: Io): void;
  /** What `remove` prints once the identity is gone. */
  removed?(id: string, io: Io): void;
  /** What has to change outside identity.json after `set --sharing`. */
  sharingNote?(id: string, sharing: "session" | "tabs" | undefined): string;
  /** Who likely holds a busy identity, and what to wait for, for `login`. */
  busy?: { holder: string; end: string };
  /** How the server starts again, for set's notes: "a new agent session". */
  restart: string;
  /** The servers that run turno-browser-mcp for each identity, for the doctor's sharing check. */
  servers?(env: NodeJS.ProcessEnv): ServedIdentity[];
  /** How `do` reaches the identity's server. Without one, `do` says what it needs. */
  doTransport?: DoTransport;
  /** Whether `Next:` hints print (turno's config.toml `hints`); on when not given. */
  hints?(env: NodeJS.ProcessEnv): boolean;
}

/** Opens a link in the default browser (`live`); tests inject a fake. */
export type OpenUrl = (url: string, io: Io) => Promise<void>;

/** How the vault and session commands read what a person types; tests replace it. */
export interface VaultInput {
  /** True when a person types on a terminal (hidden prompts), false when stdin is a pipe. */
  isTty(): boolean;
  hidden(prompt: string): Promise<string>;
  visible(prompt: string): Promise<string>;
  /** All of stdin. */
  stdin(): Promise<string>;
}

export interface CliDeps {
  /** The functions the commands call: turno-browser's own, or a test's fakes. */
  api: BrowserFunctions;
  /** True when a person can answer a question (a terminal, and no --no-input or agent session). */
  interactive(io: Io): boolean;
  /** Ask a yes/no question; true only for an explicit yes. */
  confirm(question: string, io: Io): Promise<boolean>;
  openUrl?: OpenUrl;
  input?: VaultInput;
  /** All of stdin, for `do <id> type <ref> -`. */
  stdin?: () => Promise<string>;
}

/** Everything a command gets: the host and the dependencies. */
export interface Ctx {
  host: BrowserCliHost;
  names: CliNames;
  deps: CliDeps;
  api: BrowserFunctions;
}

export function context(host: BrowserCliHost, deps: CliDeps): Ctx {
  return { host, names: host.names, deps, api: deps.api };
}

/** `open` on macOS, `xdg-open` elsewhere, detached so the command can exit. */
export const openInBrowser: OpenUrl = async (url, io) => {
  if (!/^https?:\/\//.test(url)) throw new Error(`refusing to open ${JSON.stringify(url)}: only http(s) links`);
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", env: io.env, detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

/** The line `add` prints for wiring an agent: `setup` prints the config it names. */
function setupLine(id: string): string {
  return `turno-browser setup claude-code --identity ${id}`;
}

/** turno-browser on its own: no mcp.toml, no gateway; `do` goes through the background server. */
export function standaloneHost(doDeps: BackgroundDoDeps = defaultBackgroundDoDeps): BrowserCliHost {
  return {
    names: STANDALONE_NAMES,
    footer: `Identities are persistent Chrome profiles that turno-browser-mcp serves to your coding agents.
Ids use lowercase letters, digits, "-" and "_", for example "school". Every identity keeps its
settings in identity.json (turno-browser show <id>), its sign-ins in its own profile, and its
credentials in the secret store (turno-browser vault).`,
    addSummary: "create an identity (pinned to this time zone) and print how an agent uses it",
    connect(id, _settings, io) {
      io.out("\nConnect an agent to it:");
      io.out(`  ${setupLine(id)}    # prints the config for Claude Code (codex, cursor, ...)`);
      io.out(`  turno-browser-mcp --identity ${id}    # the stdio command any MCP client runs`);
      io.out(`Sign in to your sites once with \`turno-browser login ${id}\`.`);
    },
    restart: "a new agent session",
    doTransport: backgroundTransport(doDeps),
  };
}
