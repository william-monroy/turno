import { mkdirSync } from "node:fs";
import { clearHealth } from "./health.js";
import { IdentityError, identityDir, inUseBy, isInUse } from "./identities.js";
import { readLockPid } from "./lifecycle.js";
import { CHROME_PROXY_ARGS, resolveProxy } from "./network.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { chromeEnv, keychainArgs, launchSettings, readIdentitySettings, systemTimezone } from "./settings.js";
import { names } from "./names.js";

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  /** Page to open first (default: a blank tab). */
  url?: string;
}

/**
 * Opens the identity's persistent Chrome headed, with the same launch settings as the MCP
 * server (Chrome channel, no fixed viewport, the identity's languages and time zone), and
 * resolves when the user closes the last window or quits Chrome. Used once per site so the user
 * signs in by hand. It holds the identity's runtime lock while the window is open, and clears
 * the last session health result, so the next launch checks the sign-in again.
 *
 * With identity.json `proxy`, the sign-in goes through the same proxy as the agent's sessions,
 * so the site sees one network for both. A Camoufox identity is refused: it keeps its own profile.
 */
export async function loginIdentity(id: string, options: LoginOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const dir = identityDir(id, env);
  const holder = inUseBy(id, env);
  if (holder) throw new IdentityError(holder);
  if (isInUse(id, env))
    throw new IdentityError(`identity "${id}" is in use (an MCP session holds its Chrome); close it first`);
  const settings = readIdentitySettings(id, env);
  if (settings?.engine === "camoufox" && settings.attach === undefined)
    throw new IdentityError(
      `identity "${id}" runs on Camoufox, which keeps its own profile, and \`${names().browser} login\` opens the Chrome profile: sign in from an agent session (browser_login with the vault), or use --engine chrome`,
    );
  // Read before the lock, so a missing secret leaves nothing to undo; the value goes only to Chrome.
  const proxy = settings?.proxy ? await resolveProxy(settings.proxy, env, () => {}) : undefined;
  const held = acquireRuntimeLock(id, env, { holder: "login" });
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const applied = launchSettings(settings, [], systemTimezone());
    const { chromium } = await import("patchright-core");
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      ...(applied.args.length || proxy ? { args: [...applied.args, ...(proxy ? CHROME_PROXY_ARGS : [])] } : {}),
      ...(proxy ? { proxy } : {}),
      ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
      ...keychainArgs(settings),
      // Chrome gets the caller's environment (HOME, XDG dirs), not this process's.
      env: chromeEnv(env),
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
