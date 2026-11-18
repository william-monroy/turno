import { paths, tildify } from "../../core/paths.js";
import { DRY_RUN, type FlagSpec, JSON_FLAG, bool, parseFlags, str } from "../args.js";
import { type Sub, group } from "../group.js";
import { type Command, type Io, fail, needsAnswer, paint } from "../io.js";
import { OPTIONAL, loadOptional, notInstalled } from "../optional.js";
import { emit, jsonOutput } from "../output.js";

/** `turno browser bench --json`: turno-browser's report (ADR 0045). */
const BENCH_JSON = jsonOutput(["version", "startedAt", "finishedAt", "engines", "results", "file"]);
/** `turno browser identities --json`: one element per identity. */
const IDENTITIES_JSON = jsonOutput(["id", "inUse", "dir"]);

/** The part of turno-browser this command uses. Typed locally: the package is installed apart. */
interface IdentityInfo {
  id: string;
  dir: string;
  inUse: boolean;
}

export interface BrowserModule {
  ENGINES: readonly string[];
  /** The current id for an engine name, old ids included (turno-browser 0.2 and later). */
  engineId?: (name: string) => string | undefined;
  listIdentities(env: NodeJS.ProcessEnv): IdentityInfo[];
  addIdentity(id: string, env: NodeJS.ProcessEnv): IdentityInfo;
  removeIdentity(id: string, env: NodeJS.ProcessEnv): void;
  isInUse(id: string, env: NodeJS.ProcessEnv): boolean;
  assertIdentityId(id: string): void;
  manifestSnippet(id: string): string;
  loginIdentity(id: string, options: { env: NodeJS.ProcessEnv; url?: string }): Promise<void>;
  runBench(options: {
    engines?: string[];
    urls?: string[];
    detectors?: boolean;
    env: NodeJS.ProcessEnv;
    onProgress?: (message: string) => void;
  }): Promise<{ file?: string } & Record<string, unknown>>;
  formatBenchTable(report: unknown): string;
}

export const INSTALL_HINT = OPTIONAL.browser.install;
export const NOT_INSTALLED = notInstalled(OPTIONAL.browser);

/** A turno-browser this command can drive: the calls every subcommand needs are there. */
function isBrowserModule(mod: unknown): mod is BrowserModule {
  const m = mod as Partial<BrowserModule> | undefined;
  return Boolean(m) && Array.isArray(m!.ENGINES) && typeof m!.listIdentities === "function" && typeof m!.runBench === "function";
}

/**
 * Load turno-browser: next to this install first, then (with `global`) from the global npm
 * folder, which a Homebrew or npx install of turno cannot see on its own (loadOptional).
 */
export function loadBrowser(options: { global?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<BrowserModule | undefined> {
  return loadOptional(OPTIONAL.browser, { ...options, guard: isBrowserModule });
}

export interface BrowserDeps {
  load(io: Io): Promise<BrowserModule | undefined>;
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

function checkId(mod: BrowserModule, id: string | undefined, sub: string): string {
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

async function bench(mod: BrowserModule, args: string[], io: Io, deps: BrowserDeps): Promise<number> {
  const p = parseFlags(args, BENCH_FLAGS, 0);
  const list = (name: string) => ((p.values[name] as string[] | undefined) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const given = list("engine");
  const urls = (p.values.url as string[] | undefined) ?? [];
  const onlyUrls = bool(p, "only-urls") || bool(p, "no-detectors");
  const engines: string[] = [];
  for (const e of given) {
    // An older turno-browser has no engineId: its ENGINES list is the whole truth.
    const id = mod.engineId ? mod.engineId(e) : mod.ENGINES.includes(e) ? e : undefined;
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

function identities(mod: BrowserModule, args: string[], io: Io): number {
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

function add(mod: BrowserModule, args: string[], io: Io): number {
  const p = parseFlags(args, DRY_RUN, 1);
  const id = checkId(mod, p.positionals[0], "add");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would create browser identity "${id}"`);
    return 0;
  }
  const info = mod.addIdentity(id, io.env);
  io.out(`identity "${id}" ready at ${tildify(info.dir, io.env)}`);
  io.out(`\nAdd this to ${tildify(paths(io.env).mcpFile, io.env)}, then run \`turno mcp sync\`:\n`);
  io.out(mod.manifestSnippet(id));
  io.out(`Sign in to your sites once with \`turno identity login browser:${id}\`.`);
  return 0;
}

function remove(mod: BrowserModule, args: string[], io: Io): number {
  const p = parseFlags(args, DRY_RUN, 1);
  const id = checkId(mod, p.positionals[0], "remove");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would delete browser identity "${id}" and its saved logins`);
    return 0;
  }
  mod.removeIdentity(id, io.env);
  io.out(`removed identity "${id}" and its saved browser data`);
  io.out(`Remove its [server.browser-${id}] block from ${tildify(paths(io.env).mcpFile, io.env)} if you added one.`);
  return 0;
}

async function login(mod: BrowserModule, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { url: { type: "string" } }, 1);
  const id = checkId(mod, p.positionals[0], "login");
  const url = str(p, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) return fail(`--url must start with http:// or https://: ${url}`);
  if (mod.isInUse(id, io.env)) {
    return fail(`identity "${id}" is in use by a running Chrome (probably an MCP session through mcpd). Close that session or wait for its lease to end, then retry.`);
  }
  io.out(`Opening Chrome for identity "${id}". Sign in to your sites, then close the window to save the session.`);
  const options: { env: NodeJS.ProcessEnv; url?: string } = { env: io.env };
  if (url) options.url = url;
  await mod.loginIdentity(id, options);
  io.out(`saved. Sessions using browser-${id} now start signed in.`);
  return 0;
}

/** Run one browser subcommand with a loaded module. `identity` uses it for browser:<id>. */
export async function dispatch(mod: BrowserModule, sub: string, rest: string[], io: Io, deps: BrowserDeps = defaultDeps): Promise<number> {
  try {
    switch (sub) {
      case "identities":
      case "list":
        return identities(mod, rest, io);
      case "add":
        return add(mod, rest, io);
      case "remove":
      case "rm":
        return remove(mod, rest, io);
      case "login":
        return await login(mod, rest, io);
      case "bench":
        return await bench(mod, rest, io, deps);
      default:
        return fail(`unknown browser command "${sub}"`);
    }
  } catch (err) {
    if ((err as Error).name === "IdentityError") return fail((err as Error).message);
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
    identities: { summary: "list browser identities and whether they are in use", synopsis: "[--json]", flags: ["--json"], json: IDENTITIES_JSON, run: withModule("identities") },
    list: { summary: "same as identities", hidden: true, run: withModule("identities") },
    add: { summary: "create an identity and print its mcp.toml block", synopsis: "<id> [--dry-run]", flags: ["--dry-run"], run: withModule("add") },
    remove: { summary: "delete an identity and its saved logins", synopsis: "<id> [--dry-run]", flags: ["--dry-run"], run: withModule("remove") },
    rm: { summary: "same as remove", hidden: true, run: withModule("remove") },
    login: { summary: "open the identity's Chrome to sign in by hand once", synopsis: "<id> [--url <url>]", flags: ["--url"], run: withModule("login") },
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
      "turno browser add school",
      "turno browser login school --url https://example.com",
      "turno browser remove school --dry-run",
      "turno browser bench --only-urls --url https://example.com --yes",
    ],
  });
}

export const command: Command = browserCommand();
