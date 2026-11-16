import { execFileSync } from "node:child_process";
import { type Sandbox, sandbox } from "./sandbox.js";

/**
 * Environment for a real agent binary (claude, codex, cursor-agent): the sandbox env plus
 * `extra`. Nothing comes from the live session, so the binary writes its caches and config
 * under the sandbox HOME, and TURNO_* or CLAUDE_* variables of the session running the tests
 * cannot leak in.
 */
export function realBinEnv(sb: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sb.env };
  for (const k of ["USER", "SHELL", "LANG"]) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Whether `cmd --version` runs. Probed in a throwaway sandbox, so the probe writes nothing real. */
export function hasBinary(cmd: string): boolean {
  const sb = sandbox();
  try {
    execFileSync(cmd, ["--version"], { env: realBinEnv(sb), cwd: sb.home, stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  } finally {
    sb.cleanup();
  }
}

/** Tests that need the network (Cursor talks to its servers) run only with TURNO_E2E_NETWORK=1. */
export const networkE2e = process.env.TURNO_E2E_NETWORK === "1";
export const skipE2e = Boolean(process.env.TURNO_SKIP_E2E);
