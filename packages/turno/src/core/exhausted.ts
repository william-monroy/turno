import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/** Epoch seconds until which a profile is marked exhausted, or undefined (expired marks are removed). */
export function exhaustedUntil(profile: string, env: NodeJS.ProcessEnv = process.env, now = Date.now() / 1000): number | undefined {
  const file = join(paths(env).exhaustedDir, profile);
  let until: number;
  try {
    until = Number.parseFloat(readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "");
  } catch {
    return undefined;
  }
  if (!Number.isFinite(until)) return undefined;
  if (until < now) {
    rmSync(file, { force: true });
    return undefined;
  }
  return until;
}

export function markExhausted(profile: string, until: number, env: NodeJS.ProcessEnv = process.env): void {
  const dir = paths(env).exhaustedDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, profile), `${Math.floor(until)}\n`);
}

export function clearExhausted(profile: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(join(paths(env).exhaustedDir, profile), { force: true });
}
