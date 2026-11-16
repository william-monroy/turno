import { effectivePolicy } from "../../accounts/policy.js";
import { loadRegistry } from "../../accounts/registry.js";
import { tildify } from "../../core/paths.js";
import { DRY_RUN, JSON_FLAG, bool, flagsOf, parseFlags, printJson, str } from "../args.js";
import { group } from "../group.js";
import { type Io, fail, paint } from "../io.js";
import * as accounts from "./accounts.js";
import { type BrowserDeps, type BrowserModule, NOT_INSTALLED, defaultDeps, dispatch } from "./browser.js";

/**
 * Who acts on an outside service for a session: a service account (`linear:work`, run by a
 * profile through the accounts bridge) or a browser identity (`browser:school`, a Chrome
 * profile with saved logins). One command for both; `accounts` and `browser` still work.
 */
const BROWSER = "browser:";

let deps: BrowserDeps = defaultDeps;

async function browserModule(io: Io): Promise<BrowserModule> {
  const mod = await deps.load(io);
  if (!mod) {
    io.err(`turno: ${NOT_INSTALLED}`);
    return fail("browser identities need turno-browser");
  }
  return mod;
}

/** The first argument that is not a flag or a flag value, without parsing the flags. */
function firstId(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const reg = loadRegistry(io.env);
  const mod = await deps.load(io);
  const browsers = mod ? mod.listIdentities(io.env) : [];
  if (bool(p, "json")) {
    printJson(io.out, {
      services: Object.values(reg.accounts)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          service: a.service,
          profile: a.profile,
          tools: a.tools,
          readTools: a.readTools ?? null,
          confirm: effectivePolicy(a),
          description: a.description ?? null,
        })),
      browser: browsers.map((b) => ({ id: `${BROWSER}${b.id}`, inUse: b.inUse, dir: tildify(b.dir, io.env) })),
      preferences: reg.prefer.map((r) => ({ path: tildify(r.path, io.env), accounts: r.accounts })),
    });
    return 0;
  }
  io.out(paint(io, "Service accounts", "1"));
  if (Object.keys(reg.accounts).length === 0 && reg.prefer.length === 0) {
    io.out("  none yet (turno identity add linear:work --profile work --tools 'mcp__linear__*')");
  } else {
    accounts.list(io);
  }
  io.out("");
  io.out(paint(io, "Browser identities", "1"));
  if (!mod) io.out(`  (${NOT_INSTALLED})`);
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
  if (!firstId(args)?.startsWith(BROWSER)) return accounts.add(args, io);
  const p = parseFlags(args, DRY_RUN, 1);
  const id = p.positionals[0]!.slice(BROWSER.length);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would create browser identity "${id}"`);
    return 0;
  }
  return dispatch(await browserModule(io), "add", [id], io, deps);
}

async function remove(args: string[], io: Io): Promise<number> {
  if (!firstId(args)?.startsWith(BROWSER)) return accounts.remove(args, io);
  const p = parseFlags(args, DRY_RUN, 1);
  const id = p.positionals[0]!.slice(BROWSER.length);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would delete browser identity "${id}" and its saved logins`);
    return 0;
  }
  return dispatch(await browserModule(io), "remove", [id], io, deps);
}

async function login(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { url: { type: "string" } }, 1);
  const id = p.positionals[0];
  if (!id) return fail("usage: turno identity login browser:<id> [--url <url>]");
  if (!id.startsWith(BROWSER)) return fail("only browser identities sign in by hand; service accounts sign in through their profile (claude-<profile>)");
  const url = str(p, "url");
  return dispatch(await browserModule(io), "login", [id.slice(BROWSER.length), ...(url !== undefined ? ["--url", url] : [])], io, deps);
}

/** Swap the turno-browser loader and prompt, for tests. Returns the previous ones. */
export function setBrowserDeps(next: BrowserDeps): BrowserDeps {
  const prev = deps;
  deps = next;
  return prev;
}

export const command = group(
  "identity",
  "who acts on outside services: service accounts (linear:work) and browser identities (browser:school)",
  {
    list: { summary: "service accounts, browser identities and folder preferences", synopsis: "[--json]", flags: ["--json"], run: list },
    add: {
      summary: "add a service account, or create a browser identity (browser:<id>)",
      synopsis: "<service:label> --profile <p> --tools <pattern>[,...] [--read-tools <pattern>[,...]] [--confirm always|writes|never] | browser:<id>  [--dry-run]",
      args: ["any"],
      flags: ["--profile", "--tools", "--read-tools", "--confirm", "--service", "--description", "--dry-run"],
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
    log: {
      summary: "recent calls to the accounts bridge; --verify checks the log's hash chain",
      synopsis: "[-n N] [--verify] [--json]",
      flags: flagsOf(accounts.LOG_SPEC),
      run: async (a, io) => accounts.log(a, io),
    },
  },
  { fallback: "list" },
);
