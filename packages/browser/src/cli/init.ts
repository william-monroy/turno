import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type FlagSpec, type Io, bool, fail, needsAnswer, paint, parseFlags, str } from "turno-core/cli";
import { findOnPath, tildify } from "turno-core/paths";
import type { Ctx } from "./context.js";
import { loginSummary } from "./login-summary.js";
import {
  AGENT_NAMES,
  SETUP_AGENTS,
  type SetupAgent,
  mcpCommand,
  setupConfig,
  setupLines,
  unknownAgent,
} from "./setup.js";

/**
 * `turno-browser init`: the first setup, step by step. It does what the three commands of the
 * docs do (`add`, `login`, `setup`) and asks before each step that opens a window or changes an
 * agent's config:
 *
 * 1. the identity: a name, created, or the existing one reused;
 * 2. the sign-in: Chrome opens on the identity's profile, on a first site when given;
 * 3. the agent: the agents found on this machine, and its `mcp add` command, run only on a yes
 *    (an agent without one gets the block to paste).
 *
 * Without a person to answer (`--no-input`, a pipe, an agent session) it needs `--identity` and
 * `--agent`, skips the sign-in (only a person can sign in) and runs nothing: it prints.
 */

const INIT_FLAGS: FlagSpec = {
  identity: { type: "string" },
  agent: { type: "string" },
  url: { type: "string" },
  "no-login": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
};

export const INIT_SYNOPSIS =
  "[--identity <id>] [--agent <claude-code|codex|cursor|copilot|gemini|json|none>] [--url <url>] [--no-login] [--yes] [--dry-run]";

export const INIT_DETAILS = `Sets up a browser identity and gives it to your agent, asking at each step:
  1. the identity's name (a new one is created; an existing one is used as it is)
  2. signing in by hand: Chrome opens on the identity's profile (--url opens a first site)
  3. the agent: the agents found on this machine; its mcp add command runs only if you say yes,
     and an agent without one (cursor, json) gets the block to paste

--yes answers yes to every step, --no-login skips the sign-in, --agent none skips the agent.
Without a terminal (--no-input, a pipe or an agent session) it needs --identity and --agent,
skips the sign-in and prints the agent's command instead of running it.`;

/** Runs an agent's `mcp add` command; tests replace it. Resolves to the exit code. */
export type RunCommand = (command: string, args: readonly string[], io: Io) => Promise<number>;

const runCommand: RunCommand = (command, args, io) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: io.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** The program each agent's own `mcp add` runs as: the one to look for on the PATH. */
const AGENT_PROGRAMS: Partial<Record<SetupAgent, string>> = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
};

/** The agents installed here, in the order the question lists them. */
export function detectAgents(env: NodeJS.ProcessEnv): SetupAgent[] {
  const home = env.HOME ?? "";
  return SETUP_AGENTS.filter((a) => {
    if (a === "json") return false;
    if (a === "cursor")
      return Boolean(findOnPath("cursor-agent", env)) || (home !== "" && existsSync(join(home, ".cursor")));
    const program = AGENT_PROGRAMS[a];
    return program !== undefined && Boolean(findOnPath(program, env));
  });
}

/** Split a printed shell line back into words: setup only quotes with single quotes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line))
    words.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!);
  return words;
}

async function askYes(io: Io, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const answer = (await io.ask!(`${question} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function askText(io: Io, question: string, fallback: string): Promise<string> {
  const answer = (await io.ask!(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback;
}

export async function init(c: Ctx, args: string[], io: Io, run: RunCommand = runCommand): Promise<number> {
  const p = parseFlags(args, INIT_FLAGS, 0);
  const b = c.names.browser;
  const api = c.api;
  const yes = bool(p, "yes");
  const dry = bool(p, "dry-run");
  const interactive = c.deps.interactive(io) && !dry;
  const step = (n: number, title: string) => io.out(`\n${paint(io, `Step ${n} of 3`, "2")}  ${paint(io, title, "1")}`);

  const url = str(p, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) return fail(`--url must start with http:// or https://: ${url}`);
  const agentFlag = str(p, "agent");
  if (agentFlag !== undefined && agentFlag !== "none" && !(SETUP_AGENTS as readonly string[]).includes(agentFlag))
    return fail(unknownAgent(agentFlag));
  if (!interactive && !dry && (str(p, "identity") === undefined || agentFlag === undefined)) {
    return needsAnswer(`${b} init`, "--identity and --agent");
  }

  io.out(`Set up ${b}: a browser identity, signed in once, given to your agent.`);
  io.out(paint(io, "Ctrl-C stops at any step; each step that is done stays done.", "2"));

  // 1. The identity.
  step(1, "the identity");
  const existing = api.listIdentities(io.env).map((i) => i.id);
  if (existing.length) io.out(`Identities here: ${existing.join(", ")}`);
  io.out("An identity is one Chrome profile your agent uses, with your sign-ins. Name it after what it is for.");
  let id = str(p, "identity");
  while (id === undefined) {
    const answer = await askText(io, "Name", existing.length === 1 ? existing[0]! : "personal");
    try {
      api.assertIdentityId(answer);
      id = answer;
    } catch (err) {
      io.err((err as Error).message);
    }
  }
  try {
    api.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (api.identityExists(id, io.env)) io.out(`Using the identity "${id}" that is already here.`);
  else if (dry) io.out(`(dry run) would create the identity "${id}"`);
  else {
    const info = api.addIdentity(id, io.env);
    io.out(`Created "${id}" at ${tildify(info.dir, io.env)}`);
  }

  // 2. The sign-in.
  step(2, "sign in by hand once");
  let firstSite = url;
  if (bool(p, "no-login")) io.out(`Skipped. Sign in later with ${b} login ${id}.`);
  else if (dry) io.out(`(dry run) would open Chrome for "${id}"${url ? ` on ${url}` : ""} so you sign in`);
  else if (!interactive) io.out(`Skipped: only a person can sign in. Run ${b} login ${id} on a terminal.`);
  else if (api.isInUse(id, io.env))
    io.out(`Skipped: "${id}" is in use right now. Sign in later with ${b} login ${id}.`);
  else {
    io.out("Chrome opens on this identity's profile. Sign in to the sites your agent needs, then close the window.");
    if (firstSite === undefined && !yes) {
      const answer = await askText(io, "First site to open (Enter for none)", "");
      if (answer) firstSite = /^https?:\/\//.test(answer) ? answer : `https://${answer}`;
    }
    if (await askYes(io, "Open Chrome now?", yes)) {
      const result = await api.loginIdentity(id, { env: io.env, ...(firstSite ? { url: firstSite } : {}) });
      io.out(loginSummary(c, id, result?.sites ?? []));
    } else io.out(`Skipped. Sign in later with ${b} login ${id}.`);
  }

  // 3. The agent.
  step(3, "give it to your agent");
  const found = detectAgents(io.env);
  let agent: SetupAgent | "none" | undefined = agentFlag as SetupAgent | "none" | undefined;
  if (agent === undefined) {
    io.out(
      found.length
        ? `Agents found here: ${found.map((a) => `${a} (${AGENT_NAMES[a]})`).join(", ")}`
        : "No agent found on the PATH.",
    );
    io.out(`Agents: ${SETUP_AGENTS.join(", ")}, or none.`);
    while (agent === undefined) {
      const answer = (await askText(io, "Agent", found[0] ?? "json")).toLowerCase();
      if (answer === "none" || (SETUP_AGENTS as readonly string[]).includes(answer))
        agent = answer as SetupAgent | "none";
      else io.err(unknownAgent(answer));
    }
  }
  let connected = false;
  if (agent === "none") io.out(`Skipped. ${b} setup <agent> --identity ${id} prints it later.`);
  else {
    const { command, onPath } = mcpCommand(io.env);
    const cfg = setupConfig(agent, id, command);
    if (!onPath) cfg.notes.push("turno-browser-mcp is not on the PATH here, so this names it by its full path.");
    const program = AGENT_PROGRAMS[agent];
    const runnable = cfg.shell !== null && program !== undefined && Boolean(findOnPath(program, io.env));
    if (runnable && interactive && !dry) {
      io.out(`This adds the browser to ${AGENT_NAMES[agent]}:`);
      io.out(`  ${cfg.shell}`);
      if (await askYes(io, "Run it now?", yes)) {
        const [bin, ...rest] = shellWords(cfg.shell!);
        const code = await run(bin!, rest, io);
        if (code === 0) {
          connected = true;
          io.out(`Done: ${AGENT_NAMES[agent]} has the browser "${id}".`);
        } else
          io.err(`That command ended with code ${code}; run it yourself, or ${b} setup ${agent} --identity ${id}.`);
      } else for (const l of setupLines(cfg)) io.out(l);
    } else {
      if (dry && runnable) io.out(`(dry run) would ask to run: ${cfg.shell}`);
      else for (const l of setupLines(cfg)) io.out(l);
    }
  }

  // What is left.
  io.out(`\n${paint(io, "Next", "1")}`);
  if (agent !== "none") {
    // "json" names no agent ("any MCP client"), so it reads as "your MCP client".
    const who = agent === undefined ? "your agent" : agent === "json" ? "your MCP client" : AGENT_NAMES[agent];
    const session = agent === "json" ? `a new session of ${who}` : `a new ${who} session`;
    io.out(
      `${connected ? "Start" : "Once it is added, start"} ${session} and ask it to open ${firstSite ?? "a site you signed in to"}.`,
    );
  }
  io.out(`${b} doctor checks Chrome and the identity; ${b} show ${id} shows its settings.`);
  return 0;
}
