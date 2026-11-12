import { mkdirSync } from "node:fs";
import { IdentityError, identityDir, isInUse } from "./identities.js";

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  /** Page to open first (default: a blank tab). */
  url?: string;
}

/**
 * Opens the identity's persistent Chrome headed, with the same stealth settings as the MCP
 * server (Chrome channel, no fixed viewport), and resolves when the user closes the last
 * window or quits Chrome. Used once per site so the user signs in by hand.
 */
export async function loginIdentity(id: string, options: LoginOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const dir = identityDir(id, env);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use (an MCP session holds its Chrome); close it first`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { chromium } = await import("patchright-core");
  const ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless: false, viewport: null });
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
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
