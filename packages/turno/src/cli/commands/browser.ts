import { paths, tildify } from "../../core/paths.js";
import { DRY_RUN, type FlagSpec, JSON_FLAG, bool, parseFlags, str } from "../args.js";
import { type Sub, group } from "../group.js";
import { type Command, type Io, fail, needsAnswer, paint } from "../io.js";
import type { API_VERSION, BrowserApi } from "turno-browser";
import { type LoadOptions, OPTIONAL, loadOptional, notInstalled } from "../optional.js";
import { emit, jsonOutput } from "../output.js";
import * as ident from "./browser-identity.js";
import * as session from "./browser-session.js";
import { vaultCommand } from "./browser-vault.js";

/** `turno browser bench --json`: turno-browser's report. */
const BENCH_JSON = jsonOutput(["version", "startedAt", "finishedAt", "engines", "results", "file"]);
/** `turno browser identities --json`: one element per identity. */
const IDENTITIES_JSON = jsonOutput(["id", "inUse", "dir"]);

/**
 * turno-browser's public API. The types come from the package with `import type`,
 * which the build erases: turno-browser stays an optional package, loaded at run time.
 */
export type { BrowserApi };

/**
 * The API version this turno was built against. Typed by the package's own constant, so a
 * change of its API_VERSION in the workspace fails the typecheck until this line follows.
 */
export const BROWSER_API: typeof API_VERSION = { major: 1, minor: 3 };

/** What the package exports that the loader looks at. */
interface BrowserPackage {
  API_VERSION: unknown;
  api: BrowserApi;
}

export const INSTALL_HINT = OPTIONAL.browser.install;
export const NOT_INSTALLED = notInstalled(OPTIONAL.browser);

/** A turno-browser this command can drive: its API object has the calls every subcommand needs. */
function isBrowserPackage(mod: unknown): mod is BrowserPackage {
  const api = (mod as Partial<BrowserPackage> | undefined)?.api as Partial<BrowserApi> | undefined;
  return (
    typeof api === "object" &&
    api !== null &&
    Array.isArray(api.ENGINES) &&
    typeof api.listIdentities === "function" &&
    typeof api.runBench === "function"
  );
}

/**
 * Load turno-browser's API: next to this install first, then (with `global`) from the global
 * npm folder, which a Homebrew or npx install of turno cannot see on its own (loadOptional). A
 * package whose API_VERSION does not fit is refused with one message that says what to update.
 */
export async function loadBrowser(
  options: Pick<LoadOptions<BrowserPackage>, "global" | "env" | "importer" | "globalRoot"> = {},
): Promise<BrowserApi | undefined> {
  const mod = await loadOptional(OPTIONAL.browser, { ...options, api: BROWSER_API, guard: isBrowserPackage });
  return mod?.api;
}

export interface BrowserDeps {
  load(io: Io): Promise<BrowserApi | undefined>;
  /** True when a person can answer a question (a terminal, and no --no-input or agent session). */
  interactive(io: Io): boolean;
  /** Ask a yes/no question; true only for an explicit yes. */
  confirm(question: string, io: Io): Promise<boolean>;
}

async function askOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export const defaultDeps: BrowserDeps = {
  load: (io) => loadBrowser({ global: true, env: io.env }),
  interactive: (io) => Boolean(io.ask),
  confirm: (question) => askOnTerminal(question),
};

function checkId(mod: BrowserApi, id: string | undefined, sub: string): string {
  if (!id) return fail(`browser ${sub} needs an identity id (for example: turno browser ${sub} school)`);
  try {
    mod.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  return id;
}

const BENCH_FLAGS: FlagSpec = {
  engine: { type: "string", multiple: true },
  url: { type: "string", multiple: true },
  "only-urls": { type: "boolean" },
  // Older name of --only-urls, kept so scripts keep working.
  "no-detectors": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  ...JSON_FLAG,
};

export const BENCH_PROMPT = "This opens Chrome and visits third-party test pages. Continue? [y/N] ";
const URLS_PROMPT = "This opens Chrome and visits the URLs you gave. Continue? [y/N] ";

async function bench(mod: BrowserApi, args: string[], io: Io, deps: BrowserDeps): Promise<number> {
  const p = parseFlags(args, BENCH_FLAGS, 0);
  const list = (name: string) =>
    ((p.values[name] as string[] | undefined) ?? [])
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
  const given = list("engine");
  const urls = (p.values.url as string[] | undefined) ?? [];
  const onlyUrls = bool(p, "only-urls") || bool(p, "no-detectors");
  const engines: NonNullable<ReturnType<BrowserApi["engineId"]>>[] = [];
  for (const e of given) {
    const id = mod.engineId(e);
    if (!id) return fail(`unknown engine "${e}" (known: ${mod.ENGINES.join(", ")})`);
    engines.push(id);
  }
  for (const u of urls) {
    if (!/^https?:\/\//.test(u)) return fail(`--url must start with http:// or https://: ${u}`);
  }
  if (onlyUrls && urls.length === 0) return fail("--only-urls needs at least one --url");
  // Opening a browser on outside pages needs a yes from a person: --json is not consent.
  if (!bool(p, "yes")) {
    if (!deps.interactive(io)) {
      io.err("browser bench opens Chrome and visits third-party test pages.");
      return needsAnswer("browser bench");
    }
    if (!(await deps.confirm(onlyUrls ? URLS_PROMPT : BENCH_PROMPT, io))) {
      io.err("Cancelled; nothing was opened.");
      return 1;
    }
  }
  const report = await mod.runBench({
    engines,
    urls,
    detectors: !onlyUrls,
    env: io.env,
    onProgress: (m) => io.err(paint(io, m, "2")),
  });
  if (bool(p, "json")) {
    emit(io, p, BENCH_JSON, report);
  } else {
    io.out(mod.formatBenchTable(report));
    if (report.file) io.out(`\nreport: ${tildify(report.file, io.env)}`);
  }
  return 0;
}

function identities(mod: BrowserApi, args: string[], io: Io): number {
  const p = parseFlags(args, JSON_FLAG, 0);
  const list = mod.listIdentities(io.env);
  if (bool(p, "json")) {
    emit(
      io,
      p,
      IDENTITIES_JSON,
      list.map((i) => ({ id: i.id, inUse: i.inUse, dir: tildify(i.dir, io.env) })),
    );
    return 0;
  }
  if (!list.length) {
    io.out("No browser identities yet. Create one with `turno identity add browser:<id>`.");
    return 0;
  }
  const width = Math.max(...list.map((i) => i.id.length));
  for (const i of list) {
    const state = i.inUse ? paint(io, "in use", "33") : paint(io, "free  ", "32");
    io.out(`${i.id.padEnd(width)}  ${state}  ${tildify(i.dir, io.env)}`);
  }
  return 0;
}

function add(mod: BrowserApi, args: string[], io: Io): number {
  const p = parseFlags(args, { ...DRY_RUN, ...ident.SETTINGS_FLAGS }, 1);
  const id = checkId(mod, p.positionals[0], "add");
  const settings = ident.settingsPatch(p);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would create browser identity "${id}"`);
    return 0;
  }
  const info = ident.hasSettings(settings) ? mod.addIdentity(id, io.env, settings) : mod.addIdentity(id, io.env);
  io.out(`identity "${id}" ready at ${tildify(info.dir, io.env)}`);
  io.out(`settings (time zone, languages, health check) in ${tildify(mod.identitySettingsPath(id, io.env), io.env)}`);
  io.out(`\nAdd this to ${tildify(paths(io.env).mcpFile, io.env)}, then run \`turno mcp sync\`:\n`);
  io.out(mod.manifestSnippet(id));
  io.out(`Sign in to your sites once with \`turno identity login browser:${id}\`.`);
  return 0;
}

async function remove(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const id = checkId(mod, p.positionals[0], "remove");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would delete browser identity "${id}", its saved logins and its vault credentials`);
    return 0;
  }
  if (mod.isInUse(id, io.env)) return fail(`identity "${id}" is in use by a running Chrome; close it first`);
  // The vault's secret store items first: removeIdentity refuses while they exist.
  const cleared = await mod.vaultClear(id, { env: io.env });
  if (cleared)
    io.out(`deleted ${cleared} vault credential${cleared === 1 ? "" : "s"} of "${id}" from the secret store`);
  mod.removeIdentity(id, io.env);
  io.out(`removed identity "${id}" and its saved browser data`);
  io.out(`Remove its [server.browser-${id}] block from ${tildify(paths(io.env).mcpFile, io.env)} if you added one.`);
  return 0;
}

async function login(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { url: { type: "string" } }, 1);
  const id = checkId(mod, p.positionals[0], "login");
  const url = str(p, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) return fail(`--url must start with http:// or https://: ${url}`);
  const holder = mod.inUseBy(id, io.env);
  if (holder) return fail(holder);
  if (mod.isInUse(id, io.env)) {
    return fail(
      `identity "${id}" is in use by a running Chrome (probably an MCP session through mcpd). Close that session or wait for its lease to end, then retry.`,
    );
  }
  io.out(`Opening Chrome for identity "${id}". Sign in to your sites, then close the window to save the session.`);
  const options: { env: NodeJS.ProcessEnv; url?: string } = { env: io.env };
  if (url) options.url = url;
  await mod.loginIdentity(id, options);
  io.out(`saved. Sessions using browser-${id} now start signed in.`);
  return 0;
}

/** Run one browser subcommand with a loaded module. `identity` uses it for browser:<id>. */
export async function dispatch(
  mod: BrowserApi,
  sub: string,
  rest: string[],
  io: Io,
  deps: BrowserDeps = defaultDeps,
): Promise<number> {
  try {
    switch (sub) {
      case "identities":
      case "list":
        return identities(mod, rest, io);
      case "add":
        return add(mod, rest, io);
      case "remove":
      case "rm":
        return await remove(mod, rest, io);
      case "login":
        return await login(mod, rest, io);
      case "bench":
        return await bench(mod, rest, io, deps);
      case "export":
        return await session.exportSession(mod, rest, io);
      case "import":
        return await session.importSession(mod, rest, io, deps);
      case "show":
        return ident.show(
          mod,
          checkId(
            mod,
            rest.find((a) => !a.startsWith("-")),
            "show",
          ),
          rest,
          io,
        );
      case "set":
        return ident.set(
          mod,
          checkId(
            mod,
            rest.find((a) => !a.startsWith("-")),
            "set",
          ),
          rest,
          io,
        );
      case "doctor":
        return await ident.doctor(mod, rest, io);
      case "reputation":
        return ident.reputation(mod, rest, io, (id) => checkId(mod, id, "reputation"));
      default:
        return fail(`unknown browser command "${sub}"`);
    }
  } catch (err) {
    const name = (err as Error).name;
    if (name === "IdentityError" || name === "VaultError" || name === "SealError") return fail((err as Error).message);
    throw err;
  }
}

const FOOTER = `A developer diagnostic for browser engine compatibility. It needs the separate
turno-browser package (${INSTALL_HINT}).
Identities are persistent Chrome profiles served by turno-browser-mcp, one session at a time
through mcpd; turno identity manages them too (browser:<id>). Ids use lowercase letters,
digits, "-" and "_", for example "school".`;

/** The `browser` command, with its loader and prompt injectable for tests. */
export function browserCommand(deps: BrowserDeps = defaultDeps): Command {
  const withModule =
    (sub: string): Sub["run"] =>
    async (args, io) => {
      const mod = await deps.load(io);
      if (!mod) {
        io.err(`turno: ${NOT_INSTALLED}`);
        return 1;
      }
      return dispatch(mod, sub, args, io, deps);
    };
  const subs: Record<string, Sub> = {
    identities: {
      summary: "list browser identities and whether they are in use",
      synopsis: "[--json]",
      flags: ["--json"],
      json: IDENTITIES_JSON,
      run: withModule("identities"),
    },
    list: { summary: "same as identities", hidden: true, run: withModule("identities") },
    add: {
      summary: "create an identity (pinned to this time zone) and print its mcp.toml block",
      synopsis:
        "<id> [--timezone <zone>] [--locale <tag>] [--languages <tag,...>] [--region <CC>] [--health-url <url> --health-text <text>] [--dry-run]",
      flags: ["--dry-run", ...ident.SETTINGS_FLAG_NAMES],
      run: withModule("add"),
    },
    show: {
      summary: "an identity's settings, session health and who holds it",
      synopsis: "<id> [--json]",
      flags: ["--json"],
      json: ident.SHOW_JSON,
      run: withModule("show"),
    },
    set: {
      summary: "change an identity's identity.json (an empty value removes a setting)",
      synopsis: `<id> ${ident.SET_SYNOPSIS}`,
      details: ident.SET_DETAILS,
      flags: ident.SET_FLAG_NAMES,
      json: ident.SET_JSON,
      run: withModule("set"),
    },
    doctor: {
      summary: "check Chrome, a test launch and every identity (settings, lock, sign-in), with fixes",
      synopsis: "[--fix] [--no-launch] [--json]",
      flags: ["--fix", "--no-launch", "--json"],
      json: ident.DOCTOR_JSON,
      run: withModule("doctor"),
    },
    reputation: {
      summary: "challenges each identity met per site (captcha, verify it's you, block) and their trend",
      synopsis: "[<id>] [--json]",
      flags: ["--json"],
      json: ident.REPUTATION_JSON,
      run: withModule("reputation"),
    },
    vault: {
      summary: "credentials browser_login fills without showing them to the agent",
      synopsis: "add|list|remove|submit <id> ...",
      ownHelp: true,
      run: (args, io) => vaultCommand(deps).run(args, io),
    },
    export: {
      summary: "write an identity's cookies and site storage to a file encrypted with a passphrase",
      synopsis: "<id> --out <file> [--expires 7d] [--force]",
      flags: ["--out", "--expires", "--force"],
      run: withModule("export"),
    },
    import: {
      summary: "replace an identity's session with an export (asks first), or create it",
      synopsis: "<file> [--as <id>] [--yes] [--dry-run]",
      flags: ["--as", "--yes", "--dry-run"],
      run: withModule("import"),
    },
    remove: {
      summary: "delete an identity, its saved logins and its vault",
      synopsis: "<id> [--dry-run]",
      flags: ["--dry-run"],
      run: withModule("remove"),
    },
    rm: { summary: "same as remove", hidden: true, run: withModule("remove") },
    login: {
      summary: "open the identity's Chrome to sign in by hand once",
      synopsis: "<id> [--url <url>]",
      flags: ["--url"],
      run: withModule("login"),
    },
    bench: {
      summary: "check how each browser engine loads reference test pages and your URLs (asks first)",
      synopsis: "[--engine <name>]... [--url <url>]... [--only-urls] [--yes] [--json]",
      flags: ["--engine", "--url", "--only-urls", "--yes", "--json"],
      json: BENCH_JSON,
      run: withModule("bench"),
    },
  };
  return group("browser", "developer tool: compare browser engines (needs turno-browser)", subs, {
    footer: FOOTER,
    examples: [
      "turno browser identities",
      "turno browser add school --languages es-MX,es,en",
      "turno browser show school",
      "turno browser set school --health-url https://mail.example.com/ --health-text Inbox",
      "turno browser set school --tabs-max 5 --tabs-popups keep --settle 250ms",
      "turno browser set school --block-trackers true --cache --json",
      "turno browser set school --humanize light",
      "turno browser login school --url https://example.com",
      "turno browser doctor --fix",
      "turno browser reputation school --json",
      "turno browser vault add school mail --url https://mail.example.com --username alice",
      "turno browser export school --out school.session --expires 2d",
      "turno browser import school.session --as school-laptop",
      "turno browser remove school --dry-run",
      "turno browser bench --only-urls --url https://example.com --yes",
    ],
  });
}

export const command: Command = browserCommand();
