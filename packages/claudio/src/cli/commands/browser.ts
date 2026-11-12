import { paths, tildify } from "../../core/paths.js";
import { type Command, type Io, fail, paint } from "../io.js";

const USAGE = `Usage:
  claudio browser identities                 list browser identities and whether they are in use
  claudio browser add <id>                   create an identity and print its mcp.toml block
  claudio browser remove <id>                delete an identity and its saved logins
  claudio browser login <id> [--url <url>]   open the identity's Chrome to sign in by hand once
  claudio browser bench [--engine <name>]... [--url <url>]... [--no-detectors] [--json]
                                             compare engines against bot detectors and your URLs

Identities are persistent Chrome profiles served by claudio-browser-mcp (one session at a
time through mcpd). Ids use lowercase letters, digits, "-" and "_", for example "school".
Engines: patchright-chrome-headed, patchright-chrome-headless, playwright-stock, camoufox.`;

/** The part of @claudio/browser this command uses. Typed locally: the package is optional. */
interface IdentityInfo {
  id: string;
  dir: string;
  inUse: boolean;
}

export interface BrowserModule {
  ENGINES: readonly string[];
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

const NOT_INSTALLED = `the browser package (@claudio/browser) is not installed or not built.
Install it next to claudio (it is an optional dependency) and run its build, then try again.`;

export async function loadBrowser(): Promise<BrowserModule | undefined> {
  const spec = "@claudio/browser";
  try {
    return (await import(spec)) as BrowserModule;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return undefined;
    throw err;
  }
}

function requireId(mod: BrowserModule, id: string | undefined, sub: string): string {
  if (!id) return fail(`browser ${sub} needs an identity id\n\n${USAGE}`);
  try {
    mod.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  return id;
}

/** Values of a repeatable flag; "--flag a,b" and "--flag=a" both work. */
function takeList(args: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) {
      const v = args[++i];
      if (v === undefined) return fail(`${flag} needs a value`);
      values.push(v);
    } else if (a.startsWith(`${flag}=`)) {
      values.push(a.slice(flag.length + 1));
    } else {
      rest.push(a);
    }
  }
  return { values, rest };
}

async function bench(mod: BrowserModule, args: string[], io: Io): Promise<number> {
  const engines = takeList(args, "--engine");
  const urls = takeList(engines.rest, "--url");
  const rest = urls.rest;
  const json = rest.includes("--json");
  const detectors = !rest.includes("--no-detectors");
  const unknown = rest.filter((a) => a !== "--json" && a !== "--no-detectors");
  if (unknown.length) return fail(`unknown bench argument: ${unknown[0]}\n\n${USAGE}`);
  const engineNames = engines.values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  for (const e of engineNames) {
    if (!mod.ENGINES.includes(e)) return fail(`unknown engine "${e}" (known: ${mod.ENGINES.join(", ")})`);
  }
  for (const u of urls.values) {
    if (!/^https?:\/\//.test(u)) return fail(`--url must start with http:// or https://: ${u}`);
  }
  if (!detectors && urls.values.length === 0) return fail("--no-detectors needs at least one --url");
  const report = await mod.runBench({
    engines: engineNames,
    urls: urls.values,
    detectors,
    env: io.env,
    onProgress: (m) => io.err(paint(io, m, "2")),
  });
  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(mod.formatBenchTable(report));
    if (report.file) io.out(`\nreport: ${tildify(report.file, io.env)}`);
  }
  return 0;
}

export const command: Command = {
  summary: "browser engine bench against bot detectors (identities live in claudio identity)",
  usage: USAGE,
  subcommands: { bench: { flags: ["--engine", "--url", "--no-detectors", "--json"] } },
  async run(args, io) {
    const [sub, ...rest] = args;
    if (!sub) return fail(USAGE);
    const mod = await loadBrowser();
    if (!mod) {
      io.err(`claudio: ${NOT_INSTALLED}`);
      return 1;
    }
    try {
      return await dispatch(mod, sub, rest, io);
    } catch (err) {
      if ((err as Error).name === "IdentityError") return fail((err as Error).message);
      throw err;
    }
  },
};

export async function dispatch(mod: BrowserModule, sub: string, rest: string[], io: Io): Promise<number> {
  switch (sub) {
    case "identities":
    case "list": {
      const list = mod.listIdentities(io.env);
      if (!list.length) {
        io.out("No browser identities yet. Create one with `claudio browser add <id>`.");
        return 0;
      }
      const width = Math.max(...list.map((i) => i.id.length));
      for (const i of list) {
        const state = i.inUse ? paint(io, "in use", "33") : paint(io, "free  ", "32");
        io.out(`${i.id.padEnd(width)}  ${state}  ${tildify(i.dir, io.env)}`);
      }
      return 0;
    }
    case "add": {
      const id = requireId(mod, rest[0], "add");
      const info = mod.addIdentity(id, io.env);
      io.out(`identity "${id}" ready at ${tildify(info.dir, io.env)}`);
      io.out(`\nAdd this to ${tildify(paths(io.env).mcpFile, io.env)}, then run \`claudio mcp sync\`:\n`);
      io.out(mod.manifestSnippet(id));
      io.out(`Sign in to your sites once with \`claudio browser login ${id}\`.`);
      return 0;
    }
    case "remove":
    case "rm": {
      const id = requireId(mod, rest[0], "remove");
      mod.removeIdentity(id, io.env);
      io.out(`removed identity "${id}" and its saved browser data`);
      io.out(`Remove its [server.browser-${id}] block from ${tildify(paths(io.env).mcpFile, io.env)} if you added one.`);
      return 0;
    }
    case "login": {
      const id = requireId(mod, rest[0], "login");
      const { values, rest: extra } = takeList(rest.slice(1), "--url");
      if (extra.length) return fail(`unknown login argument: ${extra[0]}`);
      if (mod.isInUse(id, io.env)) {
        return fail(`identity "${id}" is in use by a running Chrome (probably an MCP session through mcpd). Close that session or wait for its lease to end, then retry.`);
      }
      io.out(`Opening Chrome for identity "${id}". Sign in to your sites, then close the window to save the session.`);
      const options: { env: NodeJS.ProcessEnv; url?: string } = { env: io.env };
      if (values[0]) options.url = values[0];
      await mod.loginIdentity(id, options);
      io.out(`saved. Sessions using browser-${id} now start signed in.`);
      return 0;
    }
    case "bench":
      return bench(mod, rest, io);
    default:
      return fail(`unknown browser command "${sub}"\n\n${USAGE}`);
  }
}
