import type { ChildProcess } from "node:child_process";

/**
 * Poll `check` until it returns a truthy value, instead of sleeping for a guessed time.
 * Throws with `what` once `timeout` ms pass.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  what = "condition",
  { timeout = 5000, every = 10 } = {},
): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** SIGKILL a child and resolve once it has exited (at once if it already has). */
export function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill("SIGKILL");
  });
}
