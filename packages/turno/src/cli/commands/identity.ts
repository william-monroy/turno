import { effectivePolicy } from "../../accounts/policy.js";
import { loadRegistry } from "../../accounts/registry.js";
import { tildify } from "../../core/paths.js";
import { DRY_RUN, JSON_FLAG, bool, flagsOf, parseFlags, printJson, str } from "../args.js";
import { group } from "../group.js";
import { launcherExists } from "../../accounts/delegate.js";
import { loadConfig } from "../../core/config.js";
import { type Io, fail } from "../io.js";
import { profileColor, style } from "../style.js";
import * as accounts from "./accounts.js";
import { policyLine } from "./accounts.js";
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
    printJson(io, {
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
  const st = style(io);
  let colors: Record<string, { color?: string | number }> = {};
  try {
    colors = loadConfig(io.env).profiles;
  } catch {
    /* pills without their configured colors */
  }
  const pill = (name: string) => st.profile(name, profileColor(colors, name));
  io.out(st.header("Service accounts"));
  const services = Object.values(reg.accounts).sort((a, b) => a.id.localeCompare(b.id));
  if (!services.length) io.out(`  none yet ${st.muted("(turno identity add linear:work --profile work --tools 'mcp__linear__*')")}`);
  // Each account: id, profile, tools; under them its confirm policy and description.
  const rows = st.tableRows(
    services.map((a) => [
      st.bold(a.id),
      pill(a.profile),
      `${a.tools.join(", ")}${launcherExists(a.profile, io.env) ? "" : `  ${st.warn("(no launcher)")}`}`,
    ]),
  );
  // Under the profile name: a pill on a terminal starts with a space of its own.
  const under = " ".repeat(2 + Math.max(0, ...services.map((a) => a.id.length)) + 2 + (st.color ? 1 : 0));
  services.forEach((a, i) => {
    for (const l of rows[i]!) io.out(l);
    io.out(st.wrap(under, st.muted(policyLine(a))));
    if (a.description) io.out(st.wrap(under, st.muted(a.description)));
  });
  if (reg.prefer.length) {
    io.out("");
    io.out(st.header("Folder preferences"));
    for (const l of st.table(reg.prefer.map((r) => [tildify(r.path, io.env), Object.entries(r.accounts).map(([sv, id]) => `${sv}=${id}`).join("  ") || st.muted("(none)")]))) io.out(l);
  }
  io.out("");
  io.out(st.header("Browser identities"));
  if (!mod) io.out(st.note("warn", NOT_INSTALLED));
  else if (!browsers.length) io.out(`  none yet ${st.muted("(turno identity add browser:<id>)")}`);
  else {
    const rows = browsers.map((b) => [st.bold(`${BROWSER}${b.id}`), b.inUse ? st.lead("on", st.warn("in use")) : st.lead("off", st.ok("free")), st.muted(tildify(b.dir, io.env))]);
    for (const l of st.table(rows)) io.out(l);
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
