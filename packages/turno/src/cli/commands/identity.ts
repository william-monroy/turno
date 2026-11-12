import { loadRegistry } from "../../accounts/registry.js";
import { tildify } from "../../core/paths.js";
import { JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import { group } from "../group.js";
import { type Io, fail, paint } from "../io.js";
import * as accounts from "./accounts.js";
import { type BrowserModule, dispatch, loadBrowser } from "./browser.js";

/**
 * Who acts on an outside service for a session: a service account (`linear:work`, run by a
 * profile through the accounts bridge) or a browser identity (`browser:school`, a Chrome
 * profile with saved logins). One command for both; `accounts` and `browser` still work.
 */
const BROWSER = "browser:";

async function browserModule(io: Io): Promise<BrowserModule> {
  const mod = await loadBrowser();
  if (!mod) {
    io.err("turno: the browser package (turno-browser) is not installed; browser identities need it");
    return fail("browser identities are not available");
  }
  return mod;
}

async function onBrowser(mod: BrowserModule, sub: string, args: string[], io: Io): Promise<number> {
  try {
    return await dispatch(mod, sub, args, io);
  } catch (err) {
    if ((err as Error).name === "IdentityError") return fail((err as Error).message);
    throw err;
  }
}

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const reg = loadRegistry(io.env);
  const mod = await loadBrowser();
  const browsers = mod ? mod.listIdentities(io.env) : [];
  if (bool(p, "json")) {
    printJson(io.out, {
      services: Object.values(reg.accounts)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({ id: a.id, service: a.service, profile: a.profile, tools: a.tools, description: a.description ?? null })),
      browser: browsers.map((b) => ({ id: `${BROWSER}${b.id}`, inUse: b.inUse, dir: tildify(b.dir, io.env) })),
      preferences: reg.prefer.map((r) => ({ path: tildify(r.path, io.env), accounts: r.accounts })),
    });
    return 0;
  }
  io.out(paint(io, "Service accounts", "1"));
  accounts.list(io);
  io.out("");
  io.out(paint(io, "Browser identities", "1"));
  if (!mod) io.out("  (the turno-browser package is not installed)");
  else if (!browsers.length) io.out("  none yet (turno identity add browser:<id>)");
  else {
    const w = Math.max(...browsers.map((b) => b.id.length)) + BROWSER.length;
    for (const b of browsers) {
      const state = b.inUse ? paint(io, "in use", "33") : paint(io, "free  ", "32");
      io.out(`  ${`${BROWSER}${b.id}`.padEnd(w)}  ${state}  ${tildify(b.dir, io.env)}`);
    }
  }
  return 0;
}

async function add(args: string[], io: Io): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (id?.startsWith(BROWSER)) {
    if (args.includes("--dry-run")) {
      io.out(`(dry run) would create browser identity "${id.slice(BROWSER.length)}"`);
      return 0;
    }
    return onBrowser(await browserModule(io), "add", [id.slice(BROWSER.length)], io);
  }
  return accounts.add(args, io);
}

async function remove(args: string[], io: Io): Promise<number> {
  const id = args.find((a) => !a.startsWith("-"));
  if (id?.startsWith(BROWSER)) {
    if (args.includes("--dry-run")) {
      io.out(`(dry run) would delete browser identity "${id.slice(BROWSER.length)}" and its saved logins`);
      return 0;
    }
    return onBrowser(await browserModule(io), "remove", [id.slice(BROWSER.length)], io);
  }
  return accounts.remove(args, io);
}

async function login(args: string[], io: Io): Promise<number> {
  const [id, ...rest] = args;
  if (!id) return fail("usage: turno identity login browser:<id> [--url <url>]");
  if (!id.startsWith(BROWSER)) fail(`only browser identities sign in by hand; service accounts sign in through their profile (claude-<profile>)`);
  return onBrowser(await browserModule(io), "login", [id.slice(BROWSER.length), ...rest], io);
}

export const command = group(
  "identity",
  "who acts on outside services: service accounts (linear:work) and browser identities (browser:school)",
  {
    list: { summary: "service accounts, browser identities and folder preferences", synopsis: "[--json]", flags: ["--json"], run: list },
    add: {
      summary: "add a service account, or create a browser identity (browser:<id>)",
      synopsis: "<service:label> --profile <p> --tools <pattern>[,...] | browser:<id>  [--dry-run]",
      args: ["any"],
      flags: ["--profile", "--tools", "--service", "--description", "--dry-run"],
      run: add,
    },
    remove: { summary: "remove a service account, or delete a browser identity and its logins", synopsis: "<id> [--dry-run]", args: ["identity"], flags: ["--dry-run"], run: remove },
    login: { summary: "open a browser identity's Chrome to sign in by hand once", synopsis: "browser:<id> [--url <url>]", args: ["identity"], flags: ["--url"], run: login },
    prefer: {
      summary: "pick the account of a service for a folder (empty account removes it)",
      synopsis: "<dir> <service>=<account> [--dry-run]",
      args: ["dir"],
      flags: ["--dry-run"],
      run: async (a, io) => accounts.prefer(a, io),
    },
    log: { summary: "recent calls to the accounts bridge", synopsis: "[-n N]", flags: ["--tail"], run: async (a, io) => accounts.log(a, io) },
  },
  { fallback: "list" },
);
