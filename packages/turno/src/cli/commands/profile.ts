import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { editConfig } from "../../core/config-edit.js";
import { type Config, loadConfig } from "../../core/config.js";
import { exhaustedUntil } from "../../core/exhausted.js";
import { Journal } from "../../core/journal.js";
import { expandHome, paths, profileDir, tildify } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { resolveProfile } from "../../core/resolve.js";
import { addArrayTable, ensureTable, removeArrayTables, removeTable, setValue } from "../../core/toml-edit.js";
import { NAMED_COLORS } from "../../statusline/render.js";
import { DRY_RUN, JSON_FLAG, bool, parseFlags, printJson, str } from "../args.js";
import { group } from "../group.js";
import { type Io, fail } from "../io.js";
import { launcherPath } from "../launch.js";
import { isGenerated } from "../launchers.js";
import { checkName, setupProfiles } from "./setup.js";
import { authStatus } from "./usage.js";

/** A named color, or a 256-color code. */
export function parseColor(v: string): string | number {
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n > 255) fail(`--color ${v}: a 256-color code goes from 0 to 255`);
    return n;
  }
  if (NAMED_COLORS[v.toLowerCase()] === undefined) fail(`--color ${v}: use a number (0-255) or one of ${Object.keys(NAMED_COLORS).join(", ")}`);
  return v.toLowerCase();
}

export async function profilesData(env: NodeJS.ProcessEnv, config: Config, withAccounts = true) {
  const names = listProfiles(config, env);
  const auth = withAccounts ? await Promise.all(names.map((n) => authStatus(n, env))) : [];
  return names.map((name, i) => {
    const s = auth[i];
    return {
      name,
      dir: tildify(profileDir(name, env), env),
      setUp: existsSync(profileDir(name, env)) && Boolean(launcherPath(name, env)),
      ...(withAccounts ? { email: s?.loggedIn ? (s.email ?? null) : null, plan: s?.loggedIn ? (s.subscriptionType ?? null) : null } : {}),
      color: config.profiles[name]?.color ?? null,
      browser: config.profiles[name]?.browser ?? "chrome",
      roles: [config.system === name && "system", config.default === name && "default", config.fallback === name && "fallback"].filter(Boolean),
      projects: config.projects.filter((r) => r.profile === name).length,
      exhaustedUntil: exhaustedUntil(name, env) ?? null,
    };
  });
}

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const config = loadConfig(io.env);
  const rows = await profilesData(io.env, config);
  if (bool(p, "json")) {
    printJson(io.out, rows);
    return 0;
  }
  if (!rows.length) {
    io.out("No profiles yet. Create one with: turno profile add <name>");
    return 0;
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const who = r.setUp ? (r.email ? `${r.email}${r.plan ? ` · ${r.plan}` : ""}` : "not logged in") : `not set up (turno profile repair ${r.name})`;
    const extra = [r.roles.join(", "), r.projects ? `${r.projects} projects` : "", r.exhaustedUntil ? "exhausted" : ""].filter(Boolean).join(" · ");
    io.out(`${r.name.padEnd(w)}  ${who}${extra ? `  (${extra})` : ""}`);
  }
  return 0;
}

async function add(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { color: { type: "string" }, browser: { type: "string" }, ...DRY_RUN }, 1);
  const name = p.positionals[0];
  if (!name) return fail("usage: turno profile add <name> [--color <c>] [--browser chrome|default]");
  checkName(name);
  const color = str(p, "color");
  const browser = str(p, "browser");
  if (browser && browser !== "chrome" && browser !== "default") fail("--browser must be chrome or default");
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile add ${name}`, dry);
  const table = `profiles.${name}`;
  const { changed } = editConfig(io.env, journal, (t) => {
    let text = ensureTable(t, table);
    if (color) text = setValue(text, table, "color", parseColor(color));
    if (browser) text = setValue(text, table, "browser", browser);
    return text;
  });
  io.out(`${changed ? "+" : "="} [${table}] in ${tildify(paths(io.env).configFile, io.env)}${dry ? " (dry run)" : ""}`);
  if (dry) {
    io.out(`(dry run) would set up ${tildify(profileDir(name, io.env), io.env)} and the claude-${name} command`);
    return 0;
  }
  setupProfiles([name], io);
  io.out("");
  io.out(`Next: run claude-${name} and sign in with /login. turno profile list shows the account.`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

async function repair(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, {});
  const names = p.positionals.length ? p.positionals : listProfiles(loadConfig(io.env), io.env);
  if (!names.length) return fail("no profiles to repair (turno profile add <name>)");
  setupProfiles(names, io);
  return 0;
}

async function remove(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const name = p.positionals[0];
  if (!name) return fail("usage: turno profile remove <name>");
  const config = loadConfig(io.env);
  if (!listProfiles(config, io.env).includes(name)) fail(`no profile '${name}'`);
  for (const role of ["system", "default", "fallback"] as const) {
    if (config[role] === name) fail(`${name} is the ${role} profile; point ${role} elsewhere first (turno config set ${role} <profile>)`);
  }
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile remove ${name}`, dry);
  let rules = 0;
  editConfig(io.env, journal, (t) => {
    const r = removeArrayTables(removeTable(t, `profiles.${name}`), "projects", (e) => e.profile === name);
    rules = r.removed;
    return r.text;
  });
  const launcher = launcherPath(name, io.env);
  if (launcher && isGenerated(launcher)) journal.remove(launcher);
  const d = dry ? " (dry run)" : "";
  io.out(`- [profiles.${name}] and ${rules} project rules from config.toml${d}`);
  if (launcher) io.out(`- ${tildify(launcher, io.env)}${d}`);
  io.out(`${tildify(profileDir(name, io.env), io.env)} stays (sign-in, history); delete it by hand when you no longer need it.`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

function folder(arg: string | undefined, io: Io): string {
  const dir = resolvePath(expandHome(arg ?? process.cwd(), io.env));
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) fail(`no such folder: ${arg ?? dir}`);
  return dir;
}

async function which(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const dir = folder(p.positionals[0], io);
  const r = resolveProfile(dir, loadConfig(io.env), io.env);
  if (bool(p, "json")) {
    printJson(io.out, { dir: tildify(dir, io.env), assigned: r.assigned || null, chosen: r.chosen || null, reason: r.reason, note: r.note || null });
    return 0;
  }
  io.out(tildify(dir, io.env));
  io.out(`  assigned: ${r.assigned || "none"} (${r.reason})`);
  io.out(r.note ? `  using now: ${r.chosen} (${r.assigned} ${r.note})` : `  using now: ${r.chosen || "plain claude"}`);
  return 0;
}

async function assign(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 2);
  const [dirArg, name] = p.positionals;
  if (!dirArg || !name) return fail("usage: turno profile assign <dir> <profile>");
  const dir = folder(dirArg, io);
  const config = loadConfig(io.env);
  if (!listProfiles(config, io.env).includes(name)) fail(`no profile '${name}' (turno profile list)`);
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile assign ${tildify(dir, io.env)} ${name}`, dry);
  const shown = tildify(dir, io.env);
  editConfig(io.env, journal, (t) => {
    const r = removeArrayTables(t, "projects", (e) => resolvePath(expandHome(e.path ?? "", io.env)) === dir);
    return addArrayTable(r.text, "projects", { path: shown, profile: name });
  });
  io.out(`${shown} -> ${name}${dry ? " (dry run)" : ""}`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

async function unassign(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 1);
  const dir = resolvePath(expandHome(p.positionals[0] ?? process.cwd(), io.env));
  const dry = bool(p, "dry-run");
  const journal = new Journal(io.env, `profile unassign ${tildify(dir, io.env)}`, dry);
  let removed = 0;
  editConfig(io.env, journal, (t) => {
    const r = removeArrayTables(t, "projects", (e) => resolvePath(expandHome(e.path ?? "", io.env)) === dir);
    removed = r.removed;
    return r.text;
  });
  if (!removed) {
    io.out(`${tildify(dir, io.env)} has no rule of its own (turno profile which explains what applies)`);
    return 1;
  }
  io.out(`${tildify(dir, io.env)} unassigned${dry ? " (dry run)" : ""}`);
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

export const command = group(
  "profile",
  "Claude Code accounts: list, add, repair, remove, and which folders use each",
  {
    list: { summary: "each profile, its account and roles", synopsis: "[--json]", flags: ["--json"], run: list },
    add: {
      summary: "declare a profile in config.toml and set up ~/.claude-<name> and claude-<name>",
      synopsis: "<name> [--color <c>] [--browser chrome|default] [--dry-run]",
      args: ["any"],
      flags: ["--color", "--browser", "--dry-run"],
      run: add,
    },
    repair: { summary: "relink shared folders and rewrite launchers (all profiles by default)", synopsis: "[profile...]", args: ["profile"], run: repair },
    remove: {
      summary: "drop a profile from config.toml and its launcher (its folder stays)",
      synopsis: "<name> [--dry-run]",
      args: ["profile"],
      flags: ["--dry-run"],
      run: remove,
    },
    which: { summary: "which profile auto uses in a folder, and why", synopsis: "[dir] [--json]", args: ["dir"], flags: ["--json"], run: which },
    assign: { summary: "make a folder (and everything under it) use a profile", synopsis: "<dir> <profile> [--dry-run]", args: ["dir", "profile"], flags: ["--dry-run"], run: assign },
    unassign: { summary: "remove a folder's own rule", synopsis: "[dir] [--dry-run]", args: ["dir"], flags: ["--dry-run"], run: unassign },
  },
  { fallback: "list" },
);
