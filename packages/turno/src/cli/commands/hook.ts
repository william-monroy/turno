import { isValidProfileName, loadConfig } from "../../core/config.js";
import { markExhausted } from "../../core/exhausted.js";
import { profileFromConfigDir } from "../../core/profiles.js";
import { type HookPayload, isUsageLimit, resetTime } from "../../core/ratelimit.js";
import { type Command, fail } from "../io.js";

/**
 * StopFailure hook (matcher rate_limit). When the failure is a real usage limit, mark the
 * session's profile exhausted until the limit resets, so new sessions of its projects open
 * with the fallback. Returns the profile and time marked, or undefined when nothing was done.
 */
export function handleRateLimit(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): { profile: string; until: number } | undefined {
  let payload: HookPayload;
  try {
    payload = JSON.parse(input || "{}") as HookPayload;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || !isUsageLimit(payload)) return undefined; // a passing 429
  let profile: string | undefined;
  try {
    profile = profileFromConfigDir(env.CLAUDE_CONFIG_DIR, loadConfig(env), env);
  } catch {
    return undefined;
  }
  if (!profile || !isValidProfileName(profile)) return undefined;
  const until = resetTime(String(payload.error ?? ""), now);
  markExhausted(profile, until, env);
  return { profile, until: Math.floor(until) };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

export const command: Command = {
  summary: "Claude Code hooks (rate-limit: mark the account exhausted)",
  usage: [
    "Usage: turno hook rate-limit",
    "",
    "StopFailure hook with matcher rate_limit. Reads the hook payload on stdin and, for a",
    "usage limit, marks the session's profile exhausted until the limit resets.",
  ].join("\n"),
  hidden: true,
  async run(args, io) {
    if (args[0] !== "rate-limit") fail("usage: turno hook rate-limit");
    try {
      handleRateLimit(await readStdin(), io.env);
    } catch {
      // a hook must never fail the session
    }
    return 0;
  },
};
