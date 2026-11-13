import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { paths, profileDir } from "../../core/paths.js";
import { listProfiles, profileFromConfigDir } from "../../core/profiles.js";
import { type Command, type Io, fail } from "../io.js";

const USAGE = `Usage:
  turno handoff <profile|auto> [--fork] [--copy]

Prints the command that continues THIS Claude Code session under another profile:
  default   resume it there (exit this session first)
  --fork    start a new session with the conversation so far; this one keeps running
  --copy    also put the command on the clipboard

Run it from inside a Claude Code session (it reads CLAUDE_CODE_SESSION_ID). The command starts
with a cd to the folder the session began in, because claude --resume looks sessions up by
the project folder it is launched from.`;

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** The first `cwd` recorded in a transcript: where the session started. */
export function transcriptCwd(file: string): string | undefined {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line) as { cwd?: string };
      if (entry.cwd) return entry.cwd;
    } catch {
      /* partial or foreign line */
    }
  }
  return undefined;
}

export function findTranscript(configDir: string, sessionId: string): string | undefined {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const f = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface Handoff {
  command: string;
  warnings: string[];
}

export function buildHandoff(target: string, fork: boolean, env: NodeJS.ProcessEnv): Handoff {
  const sid = env.CLAUDE_CODE_SESSION_ID;
  if (!sid) fail("CLAUDE_CODE_SESSION_ID is empty; run this from inside a Claude Code session");
  const config = loadConfig(env);
  // A Claude Code session continues only under another Claude Code profile.
  const profiles = listProfiles(config, env, "claude");
  if (target !== "auto" && !profiles.includes(target)) fail(`no profile '${target}'; available: ${[...profiles, "auto"].join(", ")}`);
  const cfg = env.CLAUDE_CONFIG_DIR || paths(env).hub;
  const transcript = findTranscript(cfg, sid!);
  if (!transcript) fail(`cannot find ${sid}.jsonl under ${join(cfg, "projects")}`);
  const cwd = transcriptCwd(transcript!);
  if (!cwd) fail(`${transcript} does not say which folder the session started in`);
  const warnings: string[] = [];
  const current = profileFromConfigDir(env.CLAUDE_CONFIG_DIR, config, env);
  if (!fork && target === current) warnings.push(`this session already runs as '${target}'`);
  if (target !== "auto" && real(join(cfg, "projects")) !== real(join(profileDir(target, env), "projects"))) {
    warnings.push(`${target} does not share the projects folder with this profile, so it will not see this session (turno setup ${target})`);
  }
  const command = `cd ${shellQuote(cwd!)} && turno ${target} --resume ${sid}${fork ? " --fork-session" : ""}`;
  return { command, warnings };
}

async function copy(text: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    try {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

export const command: Command = {
  summary: "print the command to continue or fork this session under another profile",
  usage: USAGE,
  async run(args, io: Io) {
    const target = args.find((a) => !a.startsWith("--"));
    if (!target) {
      const config = loadConfig(io.env);
      io.out(`profiles: ${[...listProfiles(config, io.env, "claude"), "auto"].join(" ")}`);
      io.out(`current: ${profileFromConfigDir(io.env.CLAUDE_CONFIG_DIR, config, io.env) ?? "(none)"}`);
      io.err(USAGE);
      return 2;
    }
    const h = buildHandoff(target, args.includes("--fork"), io.env);
    for (const w of h.warnings) io.err(`warning: ${w}`);
    io.out(h.command);
    if (args.includes("--copy") && !(await copy(`${h.command}\n`))) io.err("warning: could not copy to the clipboard");
    return 0;
  },
};
