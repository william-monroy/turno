import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidProfileName, parseConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { DRY_RUN, FORCE, bool, flagsOf, parseFlags } from "../args.js";
import { type Command, type Io, fail } from "../io.js";
import { detectNerdTerminals } from "../../ui/terminals.js";
import { Journal } from "../../core/journal.js";

/** What the bash tool kept in ~/.config/claudio/proyectos and navegador. */
export interface LegacyConfig {
  system?: string;
  default?: string;
  fallback?: string;
  icons?: string;
  projects: { profile: string; path: string }[];
  browsers: Record<string, "chrome" | "default">;
  warnings: string[];
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((raw) => raw.split("#", 1)[0]!.trim())
    .filter(Boolean);
}

export function parseLegacy(proyectos: string, navegador: string): LegacyConfig {
  const out: LegacyConfig = { projects: [], browsers: {}, warnings: [] };
  for (const line of lines(proyectos)) {
    const space = line.search(/\s/);
    const key = space < 0 ? line : line.slice(0, space);
    const val = space < 0 ? "" : line.slice(space).trim();
    if (key === "respaldo") out.fallback = val;
    else if (key === "por-defecto") out.default = val;
    else if (key === "sistema") out.system = val;
    else if (key === "iconos") out.icons = val;
    else if (!isValidProfileName(key) || !val) out.warnings.push(`skipped line in proyectos: ${line}`);
    else out.projects.push({ profile: key, path: val });
  }
  for (const line of lines(navegador)) {
    const [profile, mode] = line.split(/\s+/);
    if (!profile || !isValidProfileName(profile) || (mode !== "predeterminado" && mode !== "chrome")) {
      out.warnings.push(`skipped line in navegador: ${line}`);
      continue;
    }
    out.browsers[profile] = mode === "predeterminado" ? "default" : "chrome";
  }
  return out;
}

const q = (s: string) => JSON.stringify(s);

/** config.toml text for a legacy config. */
export function legacyToToml(legacy: LegacyConfig, chromeDir?: string, nerdTerminals: string[] = []): string {
  const out: string[] = ["# Imported from the bash claudio by `turno migrate`."];
  for (const key of ["system", "default", "fallback"] as const) {
    const v = legacy[key];
    if (v && isValidProfileName(v)) out.push(`${key} = ${q(v)}`);
    else if (v) legacy.warnings.push(`skipped ${key}: invalid profile name '${v}'`);
  }
  if (legacy.icons) {
    if (["auto", "nerd", "unicode"].includes(legacy.icons)) out.push(`icons = ${q(legacy.icons)}`);
    else legacy.warnings.push(`skipped iconos '${legacy.icons}' (expected auto, nerd or unicode)`);
  }
  if (nerdTerminals.length) out.push(`nerd_terminals = [${nerdTerminals.map(q).join(", ")}]`);
  if (chromeDir) out.push("", "[open]", `chrome_dir = ${q(chromeDir)}`);
  for (const [name, browser] of Object.entries(legacy.browsers).sort()) {
    out.push("", `[profiles.${name}]`, `browser = ${q(browser)}`);
  }
  for (const rule of legacy.projects) {
    out.push("", "[[projects]]", `path = ${q(rule.path)}`, `profile = ${q(rule.profile)}`);
  }
  return `${out.join("\n")}\n`;
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Copy files from a legacy state folder when missing or older at the destination. */
function copyState(from: string, to: string, filter: (name: string) => boolean, journal: Journal): number {
  let entries: string[];
  try {
    entries = readdirSync(from);
  } catch {
    return 0;
  }
  let copied = 0;
  for (const name of entries) {
    if (!filter(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    try {
      if (!statSync(src).isFile()) continue;
      if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
    } catch {
      continue;
    }
    journal.write(dst, readFileSync(src));
    copied++;
  }
  return copied;
}

export function migrate(io: Io, opts: { dryRun?: boolean; force?: boolean } = {}): number {
  const p = paths(io.env);
  const legacyDir = p.legacyConfig;
  const prefix = opts.dryRun ? "(dry run) " : "";
  const journal = new Journal(io.env, "migrate", Boolean(opts.dryRun));
  if (!existsSync(legacyDir)) {
    io.out(`Nothing to migrate: ${tildify(legacyDir, io.env)} does not exist.`);
    return 0;
  }
  const proyectos = read(join(legacyDir, "proyectos"));
  const navegador = read(join(legacyDir, "navegador"));
  if (proyectos === undefined && navegador === undefined) {
    io.out(`No legacy proyectos or navegador in ${tildify(legacyDir, io.env)}; config.toml left as is.`);
  } else {
    const exists = existsSync(p.configFile);
    if (exists && !opts.force) {
      if (opts.dryRun)
        io.out(`${prefix}! ${tildify(p.configFile, io.env)} exists; a real run needs --force to replace it`);
      else fail(`${tildify(p.configFile, io.env)} already exists; use --force to replace it (a backup is kept)`);
    }
    const legacy = parseLegacy(proyectos ?? "", navegador ?? "");
    const legacyChrome = join(legacyDir, "chrome");
    const chromeDir = existsSync(legacyChrome) ? tildify(legacyChrome, io.env) : undefined;
    // The old status line drew Nerd icons in Warp; keep that wherever a Nerd Font is set.
    const toml = legacyToToml(legacy, chromeDir, detectNerdTerminals(io.env));
    parseConfig(toml, p.configFile, io.env); // never write a file turno cannot read back
    for (const w of legacy.warnings) io.out(`  ! ${w}`);
    journal.write(p.configFile, toml);
    if (exists) io.out(`${prefix}backed up config.toml (turno undo ${journal.stamp} puts it back)`);
    const nBrowsers = Object.keys(legacy.browsers).length;
    io.out(
      `${prefix}+ ${tildify(p.configFile, io.env)}: ${legacy.projects.length} project rules, ${nBrowsers} browser settings` +
        (chromeDir ? `, Chrome profiles kept in ${chromeDir}` : ""),
    );
    if (opts.dryRun) {
      io.out("");
      io.out(toml.trimEnd());
      io.out("");
    }
  }
  const usage = copyState(join(legacyDir, "uso"), p.usageDir, (n) => n.endsWith(".json"), journal);
  const exhausted = copyState(join(legacyDir, "agotadas"), p.exhaustedDir, isValidProfileName, journal);
  const plan = copyState(join(legacyDir, "plan"), p.planDir, isValidProfileName, journal);
  io.out(
    `${prefix}+ state: ${usage} usage snapshots, ${exhausted} exhausted marks, ${plan} plans copied to ${tildify(p.state, io.env)}/`,
  );
  io.out("Legacy files were left untouched.");
  if (journal.used) io.out(`undo with: turno undo ${journal.stamp}`);
  return 0;
}

const SPEC = { ...DRY_RUN, ...FORCE };

export const command: Command = {
  summary: "import the bash claudio config and state into the new layout",
  hidden: true,
  flags: flagsOf(SPEC),
  usage: [
    "Usage: turno migrate [--dry-run] [--force]",
    "",
    "Reads ~/.config/claudio/proyectos and navegador and writes config.toml (refuses to",
    "replace an existing one unless --force, which backs it up first). Copies usage",
    "snapshots, exhausted marks and plans to the state folder. Never changes legacy files.",
  ].join("\n"),
  async run(args, io) {
    const p = parseFlags(args, SPEC, 0);
    return migrate(io, { dryRun: bool(p, "dry-run"), force: bool(p, "force") });
  },
};
