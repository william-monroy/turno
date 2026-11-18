import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig } from "../../core/config.js";
import { ensurePrivateDir, findOnPath } from "../../core/paths.js";
import { profileFromConfigDir } from "../../core/profiles.js";
import { type Command, type Io, fail } from "../io.js";
import { checkName } from "./setup.js";

const USAGE = [
  "Usage: turno open [profile] <url>",
  "",
  "claude.ai and claude.com links open in the profile's isolated Google Chrome profile,",
  'or in the default browser when profiles.<name>.browser = "default". Other links',
  "always open in the default browser. Only http(s) and mailto links are accepted.",
  "Claude Code calls this through $BROWSER. Typed in a terminal outside a profile's session,",
  "a claude.ai link without a profile shows the profiles to choose from.",
  "",
  "Examples:",
  "  $ turno open https://claude.ai/new",
  "  $ turno open work https://claude.ai/new",
].join("\n");

/** claude.ai and claude.com links (and their subdomains) open with the profile's account. */
export function isClaudeUrl(url: string): boolean {
  return /^https:\/\/([A-Za-z0-9-]+\.)*claude\.(ai|com)\//.test(url);
}

/**
 * Links turno hands to the system opener: http(s) and mailto only. `open` and `xdg-open` also
 * run file paths, file:// URLs and custom schemes, and read a leading `-` as an option.
 */
export function isOpenableUrl(url: string): boolean {
  return !url.startsWith("-") && /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(url);
}

/** Chrome executables looked up on PATH on Linux, in order. */
export const LINUX_CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

function chromeApp(env: NodeJS.ProcessEnv): string {
  return env.TURNO_CHROME_APP || "/Applications/Google Chrome.app";
}

/** What to spawn for a link. `detach` is true for a browser started directly (it keeps running). */
export interface OpenInvocation {
  command: string;
  args: string[];
  detach?: boolean;
}

/** The Chrome profile a claude.ai link opens in, or undefined for the default browser. */
function chromeProfile(profile: string | undefined, url: string, env: NodeJS.ProcessEnv): { name: string; dir: string } | undefined {
  if (!isClaudeUrl(url)) return undefined;
  const config = loadConfig(env);
  const name = profile ?? profileFromConfigDir(env.CLAUDE_CONFIG_DIR, config, env) ?? config.system;
  if (!name) return undefined;
  checkName(name);
  if (config.profiles[name]?.browser === "default") return undefined;
  return { name, dir: config.open.chromeDir };
}

/**
 * The command that opens `url` on `platform`: `open` on macOS (Chrome through the app bundle),
 * `xdg-open` on Linux (Chrome found on PATH). Throws a usage error for anything that is not an
 * http(s) or mailto link, and on other platforms.
 */
export function openInvocation(
  profile: string | undefined,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OpenInvocation {
  if (!isOpenableUrl(url)) fail(`refusing to open ${JSON.stringify(url)}: only http(s) and mailto links`);
  if (platform !== "darwin" && platform !== "linux") fail(`turno open supports macOS and Linux, not ${platform}`);
  const chrome = chromeProfile(profile, url, env);
  if (platform === "darwin") {
    if (!chrome || !existsSync(chromeApp(env))) return { command: "open", args: [url] };
    ensurePrivateDir(chrome.dir, env);
    return { command: "open", args: ["-na", "Google Chrome", "--args", `--user-data-dir=${chrome.dir}`, `--profile-directory=${chrome.name}`, url] };
  }
  const bin = chrome && (env.TURNO_CHROME_BIN || LINUX_CHROMES.map((c) => findOnPath(c, env)).find(Boolean));
  if (chrome && bin) {
    ensurePrivateDir(chrome.dir, env);
    return { command: bin, args: [`--user-data-dir=${chrome.dir}`, `--profile-directory=${chrome.name}`, url], detach: true };
  }
  if (!findOnPath("xdg-open", env)) fail("cannot open links: xdg-open is not installed (package xdg-utils)");
  return { command: "xdg-open", args: [url] };
}

/** The `open` argv on macOS (kept for callers that only target macOS). */
export function openArgs(profile: string | undefined, url: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return openInvocation(profile, url, env, "darwin").args;
}

/**
 * The profile for a claude.ai link typed in a terminal without one: outside a profile's session
 * a person chooses (the system profile first). Claude Code calling through $BROWSER, a script or
 * an agent never sees the picker and keeps the default.
 */
async function chooseProfile(url: string, io: Io): Promise<string | undefined> {
  if (!io.ask || !isOpenableUrl(url) || !isClaudeUrl(url)) return undefined;
  const config = loadConfig(io.env);
  // A profile's session (its launcher sets CLAUDE_CONFIG_DIR) opens links with its own account.
  if (io.env.CLAUDE_CONFIG_DIR && profileFromConfigDir(io.env.CLAUDE_CONFIG_DIR, config, io.env)) return undefined;
  const { pickProfile } = await import("../picker.js");
  return pickProfile(io, { command: "open", title: "Open the link with", agent: "claude", ...(config.system ? { initial: config.system } : {}) });
}

export const command: Command = {
  summary: "open a claude.ai link with an account (default: the session's)",
  usage: USAGE,
  async run(args, io) {
    if (args.includes("--help") || args.includes("-h")) {
      io.out(USAGE);
      return 0;
    }
    if (args.length > 2) fail("usage: turno open [profile] <url>");
    let [profile, url] = args.length === 2 ? [args[0], args[1]] : [undefined, args[0]];
    if (!url) fail("usage: turno open [profile] <url>");
    profile ??= await chooseProfile(url, io);
    const inv = openInvocation(profile, url, io.env);
    return new Promise<number>((resolve) => {
      const child = spawn(inv.command, inv.args, inv.detach ? { stdio: "ignore", env: io.env, detached: true } : { stdio: "inherit", env: io.env });
      child.on("error", (err: NodeJS.ErrnoException) => {
        io.err(`turno: open: ${err.code === "ENOENT" ? `${inv.command} not found` : err.message}`);
        resolve(1);
      });
      if (inv.detach) {
        // Chrome either hands the link to a running instance and exits, or becomes the browser.
        child.on("spawn", () => {
          child.unref();
          resolve(0);
        });
      } else {
        child.on("exit", (code) => resolve(code ?? 1));
      }
    });
  },
};
