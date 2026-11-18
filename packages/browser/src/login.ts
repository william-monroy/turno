import { mkdirSync } from "node:fs";
import { clearHealth } from "./health.js";
import { IdentityError, identityDir, inUseBy, isInUse } from "./identities.js";
import { readLockPid } from "./lifecycle.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { launchSettings, readIdentitySettings, systemTimezone } from "./settings.js";

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  /** Page to open first (default: a blank tab). */
  url?: string;
}

/**
 * Opens the identity's persistent Chrome headed, with the same stealth settings as the MCP
 * server (Chrome channel, no fixed viewport, the identity's languages and time zone), and
 * resolves when the user closes the last window or quits Chrome. Used once per site so the user
 * signs in by hand. It holds the identity's runtime lock while the window is open, and clears
 * the last session health result, so the next launch checks the sign-in again (ADR 0044).
 */
export async function loginIdentity(id: string, options: LoginOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const dir = identityDir(id, env);
  const holder = inUseBy(id, env);
  if (holder) throw new IdentityError(holder);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use (an MCP session holds its Chrome); close it first`);
  const settings = readIdentitySettings(id, env);
  const held = acquireRuntimeLock(id, env, { holder: "login" });
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const applied = launchSettings(settings, [], systemTimezone());
    const { chromium } = await import("patchright-core");
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      ...(applied.args.length ? { args: applied.args } : {}),
      ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
    });
    const pid = readLockPid(dir);
    if (pid !== undefined) held.update({ chromePid: pid, pgid: pid });
    const closed = new Promise<void>((resolve) => ctx.on("close", () => resolve()));
    // On macOS Chrome keeps running with no windows, so treat "last page closed" as done.
    const watch = (page: { on(event: "close", cb: () => void): unknown }) =>
      page.on("close", () => {
        setTimeout(() => {
          if (ctx.pages().length === 0) void ctx.close().catch(() => undefined);
        }, 250);
      });
    ctx.pages().forEach(watch);
    ctx.on("page", watch);
    const stop = () => void ctx.close().catch(() => undefined);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (options.url) await page.goto(options.url).catch(() => undefined);
      await closed;
      clearHealth(id, env);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    held.release();
  }
}
