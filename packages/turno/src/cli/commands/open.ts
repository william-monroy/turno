import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "../../core/config.js";
import { profileFromConfigDir } from "../../core/profiles.js";
import { type Command, fail } from "../io.js";
import { checkName } from "./setup.js";

/** claude.ai and claude.com links (and their subdomains) open with the profile's account. */
export function isClaudeUrl(url: string): boolean {
  return /^https:\/\/([A-Za-z0-9-]+\.)*claude\.(ai|com)\//.test(url);
}

function chromeApp(env: NodeJS.ProcessEnv): string {
  return env.TURNO_CHROME_APP || "/Applications/Google Chrome.app";
}

/** The `open` invocation for a link: argv for /usr/bin/open. */
export function openArgs(profile: string | undefined, url: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isClaudeUrl(url)) return [url];
  const config = loadConfig(env);
  const name = profile ?? profileFromConfigDir(env.CLAUDE_CONFIG_DIR, config, env) ?? config.system;
  if (!name) return [url];
  checkName(name);
  if (config.profiles[name]?.browser === "default") return [url];
  if (!existsSync(chromeApp(env))) return [url];
  mkdirSync(config.open.chromeDir, { recursive: true });
  return ["-na", "Google Chrome", "--args", `--user-data-dir=${config.open.chromeDir}`, `--profile-directory=${name}`, url];
}

export const command: Command = {
  summary: "open a claude.ai link with an account (default: the session's)",
  usage: [
    "Usage: turno open [profile] <url>",
    "",
    "claude.ai and claude.com links open in the profile's isolated Google Chrome profile,",
    'or in the default browser when profiles.<name>.browser = "default". Other links',
    "always open in the default browser. Claude Code calls this through $BROWSER.",
  ].join("\n"),
  async run(args, io) {
    let profile: string | undefined;
    let rest = args;
    if (rest.length >= 2) {
      profile = rest[0];
      rest = rest.slice(1);
    }
    const url = rest[0];
    if (!url) fail("usage: turno open [profile] <url>");
    const argv = openArgs(profile, url, io.env);
    return new Promise<number>((resolve) => {
      const child = spawn("open", argv, { stdio: "inherit", env: io.env });
      child.on("error", (err) => {
        io.err(`turno: open: ${err.message}`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
  },
};
