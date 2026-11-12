import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { NERD } from "../../statusline/render.js";
import { codePoints } from "../../ui/cmap.js";
import { type FontSource, checkFonts, fontSource, installFonts, userFontDir } from "../../ui/fonts.js";
import { currentStatusLine, isClaudioStatusLine, setStatusLine, withNerdTerminals, writeText } from "../../ui/settings.js";
import { BUILTIN_SYMBOLS, currentTerminal } from "../../ui/terminal-id.js";
import { TERMINALS, type Terminal, detectNerdTerminals, fontOf, installed, isNerdFamily, terminal } from "../../ui/terminals.js";
import { type Command, type Io, fail, paint } from "../io.js";
import { findOnPath } from "../launch.js";
import { isLegacyScript } from "./doctor.js";
import { stamp } from "./setup.js";

const USAGE = `Usage:
  claudio ui status                  font, status line and icons, terminal by terminal
  claudio ui install [options]       set up the claudio look of Claude Code
      --terminal <ids>               also set the font in these terminals: current, all, or a
                                     comma list of warp, vscode, cursor, alacritty
      --no-font                      leave the font alone
      --no-statusline                leave Claude Code's settings.json alone
      --force                        replace font files that have the same name but other bytes
      --dry-run                      print what would change and change nothing

install copies MesloLGS Nerd Font 3.4.0 (the Nerd Font the icons come from, the same
release Orca ships) into your user font folder,
points the statusLine of the hub settings.json (shared by every profile) at
\`claudio statusline\`, and records in config.toml which terminals already use a Nerd Font,
so \`icons = "auto"\` draws Nerd icons there and Unicode ones elsewhere. Every file it changes
is backed up first under ~/.local/state/claudio/backups/<stamp>/ui/.`;

interface Options {
  terminals: string[];
  font: boolean;
  statusline: boolean;
  force: boolean;
  dryRun: boolean;
}

function parse(args: string[]): Options {
  const o: Options = { terminals: [], font: true, statusline: true, force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--no-font") o.font = false;
    else if (a === "--no-statusline") o.statusline = false;
    else if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--terminal" || a.startsWith("--terminal=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (!v) fail("--terminal needs a value");
      o.terminals.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    } else fail(`unknown option ${a}`);
  }
  return o;
}

/** Terminal ids to configure, from --terminal values. */
function chosenTerminals(values: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Terminal[] {
  const out = new Map<string, Terminal>();
  for (const v of values) {
    if (v === "all") {
      for (const t of TERMINALS) if (t.write && installed(t, env, platform)) out.set(t.id, t);
      continue;
    }
    const id = v === "current" ? currentTerminal(env) : v;
    const t = id ? terminal(id) : undefined;
    if (!t) fail(v === "current" ? "could not tell which terminal this is; name it (warp, vscode, cursor, alacritty)" : `unknown terminal '${v}'`);
    out.set(t.id, t);
  }
  return [...out.values()];
}

/** The claudio on PATH, unless it is still the bash original: then this very script. */
export function statusLineCommand(env: NodeJS.ProcessEnv, self = process.argv[1]): string {
  const bin = findOnPath("claudio", env);
  if (bin && !isLegacyScript(bin)) return `${tildify(bin, env)} statusline`;
  if (self) {
    try {
      return `${tildify(realpathSync(self), env)} statusline`;
    } catch {
      /* fall through */
    }
  }
  return "claudio statusline";
}

/** Status line icons missing from a font file. */
function missingGlyphs(file: string): number[] {
  const have = codePoints(readFileSync(file));
  return Object.values(NERD)
    .map((g) => g.codePointAt(0)!)
    .filter((c) => !have.has(c));
}

async function status(io: Io): Promise<number> {
  const env = io.env;
  const platform = process.platform;
  const p = paths(env);
  const source = await fontSource();
  const ok = (s: string) => paint(io, s, "32");
  const warn = (s: string) => paint(io, s, "33");

  const dir = userFontDir(env, platform);
  if (!dir) io.out(`font      ${warn(`no user font folder on ${platform}; install ${source.family} by hand`)}`);
  else {
    const checks = checkFonts(source, dir);
    const have = checks.filter((c) => c.state === "installed").length;
    if (have === checks.length) {
      const missing = missingGlyphs(checks[0]!.target);
      io.out(`font      ${ok(`${source.family} installed`)} in ${tildify(dir, env)}`);
      io.out(`          ${missing.length ? warn(`missing ${missing.length} status line icons`) : `has all ${Object.keys(NERD).length} status line icons`}`);
    } else {
      const other = checks.filter((c) => c.state === "different").length;
      const elsewhere = platform === "darwin" && checks.every((c) => existsSync(join("/Library/Fonts", c.file)));
      const note = elsewhere ? " (found in /Library/Fonts)" : other ? ` (${other} with other contents)` : "";
      io.out(`font      ${warn(`${source.family}: ${have}/${checks.length} files`)} in ${tildify(dir, env)}${note}; claudio ui install`);
    }
  }

  const s = currentStatusLine(join(p.hub, "settings.json"));
  const where = tildify(join(p.hub, "settings.json"), env);
  if (isClaudioStatusLine(s)) io.out(`status    ${ok(`${where} runs \`${s!.command}\``)}${s!.refreshInterval ? ` every ${s!.refreshInterval} s` : ""}`);
  else if (s) io.out(`status    ${warn(`${where} runs \`${s.command}\``)}; claudio ui install switches it`);
  else io.out(`status    ${warn(`no statusLine in ${where}`)}; claudio ui install adds it`);

  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.out(`config    ${warn((err as Error).message)}`);
  }
  const here = currentTerminal(env);
  const nerdList = config?.nerdTerminals ?? [];
  const shown = TERMINALS.filter((t) => t.id === here || installed(t, env, platform));
  for (const [i, t] of shown.entries()) {
    const font = fontOf(t, env, platform);
    const nerd = BUILTIN_SYMBOLS.has(t.id) || nerdList.includes(t.id);
    let line = `${t.name}${t.id === here ? " (this one)" : ""}: `;
    if (t.symbols) line += "ships the icons";
    else if (font !== undefined) line += `font ${font}`;
    else if (t.manual) line += "font set in the app";
    else line += "default font";
    line += nerd ? `, ${ok("Nerd icons")}` : `, Unicode icons`;
    if (!nerd && isNerdFamily(font)) line += " (claudio ui install records it)";
    else if (!nerd && t.write) line += ` (claudio ui install --terminal ${t.id})`;
    else if (!nerd && t.manual) line += ` (${t.manual}, then add "${t.id}" to nerd_terminals)`;
    else if (nerd && t.write && font !== undefined && font !== source.family) {
      line += ` (claudio ui install --terminal ${t.id} switches it to ${source.family})`;
    }
    io.out(`${i === 0 ? "terminal  " : "          "}${line}`);
  }
  const icons = config?.icons ?? "auto";
  io.out(`icons     ${icons}${icons === "auto" ? `: ${here && (BUILTIN_SYMBOLS.has(here) || nerdList.includes(here)) ? "Nerd" : "Unicode"} here` : ""}`);
  return 0;
}

async function install(args: string[], io: Io): Promise<number> {
  const o = parse(args);
  const env = io.env;
  const platform = process.platform;
  const targets = chosenTerminals(o.terminals, env, platform); // validate before changing anything
  const p = paths(env);
  const backups = join(p.backupsDir, stamp(), "ui");
  const dry = o.dryRun ? " (dry run)" : "";
  let source: FontSource | undefined;

  if (o.font) {
    source = await fontSource();
    const dir = userFontDir(env, platform);
    if (!dir) io.out(`font: no user font folder on ${platform}; install ${source.family} by hand from ${source.files[0]!.url}`);
    else {
      const results = await installFonts(source, { dir, force: o.force, dryRun: o.dryRun, platform, env });
      for (const r of results) {
        const what = {
          kept: "already installed",
          copied: "installed",
          downloaded: "downloaded and installed",
          skipped: "skipped: a different file has this name (--force replaces it)",
        }[r.action];
        io.out(`font: ${r.file} ${what}${r.action === "kept" || r.action === "skipped" ? "" : dry}`);
      }
      if (results.some((r) => r.action === "copied" || r.action === "downloaded") && !o.dryRun) {
        io.out("font: restart open terminals so they see the new font");
      }
    }
  }

  if (o.statusline) {
    const r = setStatusLine(join(p.hub, "settings.json"), statusLineCommand(env), {
      dryRun: o.dryRun,
      backupDir: join(backups, "claude"),
    });
    if (!r.changed) io.out(`statusline: ${tildify(r.file, env)} already runs \`${r.after.command}\``);
    else {
      io.out(`statusline: ${tildify(r.file, env)} now runs \`${r.after.command}\` every ${r.after.refreshInterval} s${dry}`);
      if (r.before) io.out(`statusline: it ran \`${r.before.command}\`${r.backup ? `; backup in ${tildify(r.backup, env)}` : ""}`);
    }
  }

  const family = source?.family ?? (await fontSource()).family;
  for (const t of targets) {
    if (t.symbols) {
      io.out(`${t.name}: ships the icons, nothing to change`);
      continue;
    }
    if (!t.config || !t.write) {
      io.out(`${t.name}: set it by hand: ${t.manual}`);
      continue;
    }
    const file = t.config(env, platform);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const after = t.write(before, family);
    if (after === before) {
      io.out(`${t.name}: already uses ${family}`);
      continue;
    }
    const was = t.read?.(before);
    if (!o.dryRun) writeText(file, after, join(backups, t.id));
    io.out(`${t.name}: font ${was ? `${was} -> ` : ""}${family} in ${tildify(file, env)}${dry}`);
  }

  // Record every terminal that now draws Nerd icons, after the font changes above.
  const detected = o.dryRun
    ? [...detectNerdTerminals(env, platform), ...targets.filter((t) => t.write).map((t) => t.id)]
    : detectNerdTerminals(env, platform);
  let current: string[] = [];
  try {
    current = loadConfig(env).nerdTerminals;
  } catch (err) {
    io.out(`config: ${(err as Error).message}; nerd_terminals not updated`);
    return 1;
  }
  const merged = [...new Set([...current, ...detected])].sort();
  if (merged.join() !== [...current].sort().join()) {
    const text = existsSync(p.configFile) ? readFileSync(p.configFile, "utf8") : "";
    if (!o.dryRun) writeText(p.configFile, withNerdTerminals(text, merged), join(backups, "config"));
    io.out(`config: nerd_terminals = [${merged.join(", ")}] in ${tildify(p.configFile, env)}${dry}`);
  }
  return 0;
}

export const command: Command = {
  summary: "install the status line font and set up the claudio look of Claude Code",
  usage: USAGE,
  async run(args, io) {
    const [sub, ...rest] = args;
    if (sub === "status" || sub === undefined) return status(io);
    if (sub === "install") return install(rest, io);
    if (sub === "--help" || sub === "-h") {
      io.out(USAGE);
      return 0;
    }
    return fail(`unknown subcommand '${sub}'\n\n${USAGE}`);
  },
};
