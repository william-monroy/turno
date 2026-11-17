import { loadConfig } from "../../core/config.js";
import { tildify } from "../../core/paths.js";
import { displayName, liveSessions } from "../../core/sessions.js";
import { JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import { group } from "../group.js";
import type { Io } from "../io.js";
import { command as handoff } from "./handoff.js";
import { command as sessions } from "./sessions.js";

export function sessionsData(env: NodeJS.ProcessEnv) {
  const config = loadConfig(env);
  return liveSessions(env, config).map((s) => ({
    name: displayName(s),
    profile: s.source === "record" ? (s.profile ?? null) : s.source === "desktop" ? null : (config.system ?? null),
    source: s.source,
    status: s.status,
    cwd: s.cwd,
  }));
}

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  if (bool(p, "json")) {
    printJson(io, sessionsData(io.env).map((s) => ({ ...s, cwd: tildify(s.cwd, io.env) })));
    return 0;
  }
  return sessions.run([], io);
}

export const command = group(
  "session",
  "live Claude Code sessions, and moving one to another account",
  {
    list: { summary: "live sessions and the account of each", synopsis: "[--json]", flags: ["--json"], run: list },
    handoff: {
      summary: "print the command that continues or forks this session under another profile",
      synopsis: "[profile|auto] [--fork] [--copy]",
      args: ["profile-or-auto"],
      flags: ["--fork", "--copy"],
      run: (args, io) => handoff.run(args, io),
    },
  },
  { fallback: "list" },
);
