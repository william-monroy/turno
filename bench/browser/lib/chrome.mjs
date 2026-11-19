// The reference for the fingerprint bench: the same installed Chrome, started directly with no
// automation at all (no DevTools protocol, no Playwright switches), on a throwaway profile.
// What the probe sees there is what a page sees from a person's Chrome on this machine.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_PATHS = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
};

/** The Chrome executable: an explicit path, else the usual install location. */
export function findChrome(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  return (CHROME_PATHS[process.platform] ?? []).find((p) => existsSync(p));
}

/**
 * Switches that keep a fresh profile quiet (no first-run pages, no sync, no default-browser
 * prompt) and away from the system's secret store: with the mock keychain Chrome never reads or
 * creates a Keychain or Secret Service item. None of them changes what a page can observe.
 */
const QUIET = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--use-mock-keychain",
  "--password-store=basic",
];

/**
 * Starts Chrome on `url` with a throwaway profile, in its own process group, and returns a
 * stop function that ends the whole group and deletes the profile. Its own `--user-data-dir`
 * makes it a separate Chrome instance: a Chrome the user has open is never touched.
 */
export function startPlainChrome(chrome, url, { headed = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "turno-fp-ref-"));
  const child = spawn(chrome, [`--user-data-dir=${profile}`, ...QUIET, ...(headed ? [] : ["--headless"]), url], {
    detached: true,
    stdio: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: profile, TMPDIR: process.env.TMPDIR ?? tmpdir() },
  });
  child.on("error", () => undefined);
  return {
    async stop() {
      for (const sig of ["SIGTERM", "SIGKILL"]) {
        try {
          process.kill(-child.pid, sig);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, sig === "SIGTERM" ? 1500 : 200));
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * The DOM of a page after its scripts ran, from a headless Chrome with no automation
 * (`--dump-dom`): the reference for the public detector pages.
 */
export function dumpDom(chrome, url, { budgetMs = 8000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "turno-fp-dump-"));
  return new Promise((resolveDom) => {
    execFile(
      chrome,
      [`--user-data-dir=${profile}`, ...QUIET, "--headless", "--dump-dom", `--virtual-time-budget=${budgetMs}`, url],
      {
        timeout: budgetMs + 30_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: profile, TMPDIR: process.env.TMPDIR ?? tmpdir() },
      },
      (err, stdout) => {
        rmSync(profile, { recursive: true, force: true });
        resolveDom(err && !stdout ? { error: String(err.message).split("\n")[0] } : { html: stdout });
      },
    );
  });
}
