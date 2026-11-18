import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../core/config.js";
import { paths, tildify } from "../../core/paths.js";
import { NERD } from "../../statusline/render.js";
import { codePoints } from "../../ui/cmap.js";
import { type FontSource, checkFonts, fontSource, installFonts, userFontDir } from "../../ui/fonts.js";
import { currentStatusLine, isTurnoStatusLine, setStatusLine, withNerdTerminals } from "../../ui/settings.js";
import { Journal } from "../../core/journal.js";
import { BUILTIN_SYMBOLS, currentTerminal } from "../../ui/terminal-id.js";
import { TERMINALS, type Terminal, detectNerdTerminals, fontOf, installed, isNerdFamily, terminal } from "../../ui/terminals.js";
import { DRY_RUN, FORCE, type FlagSpec, bool, flagsOf, parseFlags } from "../args.js";
import { group } from "../group.js";
import { type Io, fail, paint } from "../io.js";
import { findOnPath } from "../launch.js";
import { refuseNpx } from "../launchers.js";
import { isLegacyScript } from "./doctor.js";

const INSTALL_SPEC: FlagSpec = {
  terminal: { type: "string", multiple: true },
  "no-font": { type: "boolean" },
  "no-statusline": { type: "boolean" },
  ...FORCE,
  ...DRY_RUN,
};

const INSTALL_HELP = `Options:
  --terminal <ids>   also set the font in these terminals: current, all, or a
                     comma list of warp, vscode, cursor, alacritty
  --no-font          leave the font alone
  --no-statusline    leave Claude Code's settings.json alone
  --force            replace font files that have the same name but other bytes
  --dry-run          print what would change and change nothing

install copies MesloLGS Nerd Font 3.4.0 (the Nerd Font the icons come from) into
your user font folder, points the statusLine of the hub settings.json (shared by
every profile) at \`turno statusline\`, and records in config.toml which terminals
already use a Nerd Font, so \`icons = "auto"\` draws Nerd icons there and Unicode
ones elsewhere. Every file it changes is backed up first under
~/.local/state/turno/backups/<stamp>/, and turno undo puts it back.`;

interface Options {
  terminals: string[];
  font: boolean;
  statusline: boolean;
  force: boolean;
  dryRun: boolean;
}

function parse(args: string[]): Options {
  const p = parseFlags(args, INSTALL_SPEC, 0);
  const values = (p.values.terminal as string[] | undefined) ?? [];
  return {
    terminals: values.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
    font: !bool(p, "no-font"),
    statusline: !bool(p, "no-statusline"),
    force: bool(p, "force"),
    dryRun: bool(p, "dry-run"),
  };
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

/** The status line command, and a warning when it holds a path that may stop working. */
export function statusLineInfo(env: NodeJS.ProcessEnv, self = process.argv[1]): { command: string; warning?: string } {
  const bin = findOnPath("turno", env);
  if (bin && !isLegacyScript(bin) && !bin.includes("/_npx/")) return { command: `${tildify(bin, env)} statusline` };
  if (self) {
    try {
      const real = tildify(realpathSync(self), env);
      return { command: `${real} statusline`, warning: `wrote an absolute path (${real}) because turno is not on your PATH; it breaks if you switch Node versions or move this copy` };
    } catch {
      /* fall through */
    }
  }
  return { command: "turno statusline" };
}

/** The turno on PATH, unless it is still the bash original: then this very script. */
export function statusLineCommand(env: NodeJS.ProcessEnv, self = process.argv[1]): string {
  return statusLineInfo(env, self).command;
}

/** Status line icons missing from a font file. */
function missingGlyphs(file: string): number[] {
  const have = codePoints(readFileSync(file));
  return Object.values(NERD)
    .map((g) => g.codePointAt(0)!)
    .filter((c) => !have.has(c));
}

async function status(args: string[], io: Io): Promise<number> {
  parseFlags(args, {}, 0);
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
      io.out(`font      ${warn(`${source.family}: ${have}/${checks.length} files`)} in ${tildify(dir, env)}${note}; turno ui install`);
    }
  }

  const s = currentStatusLine(join(p.hub, "settings.json"));
  const where = tildify(join(p.hub, "settings.json"), env);
  if (isTurnoStatusLine(s)) io.out(`status    ${ok(`${where} runs \`${s!.command}\``)}${s!.refreshInterval ? ` every ${s!.refreshInterval} s` : ""}`);
  else if (s) io.out(`status    ${warn(`${where} runs \`${s.command}\``)}; turno ui install switches it`);
  else io.out(`status    ${warn(`no statusLine in ${where}`)}; turno ui install adds it`);

  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.out(`config    ${warn((err as Error).message)}`);
  }
  const here = currentTerminal(env);
  const nerdList = config?.nerdTerminals ?? [];
  const premigrate = !existsSync(p.configFile) && ["proyectos", "navegador"].some((f) => existsSync(join(p.legacyConfig, f)));
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
    if (!nerd && isNerdFamily(font)) line += ` (turno ${premigrate ? "migrate" : "ui install"} records it)`;
    else if (!nerd && t.write) line += ` (turno ui install --terminal ${t.id})`;
    else if (!nerd && t.manual) line += ` (${t.manual}, then add "${t.id}" to nerd_terminals)`;
    else if (nerd && t.write && font !== undefined && font !== source.family) {
      line += ` (turno ui install --terminal ${t.id} switches it to ${source.family})`;
    }
    io.out(`${i === 0 ? "terminal  " : "          "}${line}`);
  }
  const icons = config?.icons ?? "auto";
  io.out(`icons     ${icons}${icons === "auto" ? `: ${here && (BUILTIN_SYMBOLS.has(here) || nerdList.includes(here)) ? "Nerd" : "Unicode"} here` : ""}`);
  return 0;
}

async function install(args: string[], io: Io): Promise<number> {
  const o = parse(args);
  // The status line keeps the path of this turno; a path into npx's cache disappears.
  if (o.statusline) refuseNpx();
  const env = io.env;
  const platform = process.platform;
  const targets = chosenTerminals(o.terminals, env, platform); // validate before changing anything
  const p = paths(env);
  const journal = new Journal(env, `ui install ${args.join(" ")}`.trim(), o.dryRun);
  const dry = o.dryRun ? " (dry run)" : "";
  let source: FontSource | undefined;

  if (o.font) {
    source = await fontSource();
    const dir = userFontDir(env, platform);
    if (!dir) io.out(`font: no user font folder on ${platform}; install ${source.family} by hand from ${source.files[0]!.url}`);
    else {
      const results = await installFonts(source, { dir, force: o.force, dryRun: o.dryRun, platform, env, journal });
      for (const r of results) {
        const what = {
          kept: "already installed",
          copied: o.dryRun ? "would be installed" : "installed",
          downloaded: o.dryRun ? "would be downloaded and installed" : "downloaded and installed",
          skipped: "skipped: a different file has this name (--force replaces it)",
        }[r.action];
        io.out(`font: ${r.file} ${what}`);
      }
      if (results.some((r) => r.action === "copied" || r.action === "downloaded") && !o.dryRun) {
        io.out("font: restart open terminals so they see the new font");
      }
    }
  }

  if (o.statusline) {
    const line = statusLineInfo(env);
    const r = setStatusLine(join(p.hub, "settings.json"), line.command, journal);
    if (!r.changed) io.out(`statusline: ${tildify(r.file, env)} already runs \`${r.after.command}\``);
    else {
      io.out(`statusline: ${tildify(r.file, env)} now runs \`${r.after.command}\` every ${r.after.refreshInterval} s${dry}`);
      if (r.before) io.out(`statusline: it ran \`${r.before.command}\``);
      if (line.warning) io.out(`statusline: ${line.warning}`);
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
    journal.write(file, after);
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
  const legacy = ["proyectos", "navegador"].some((f) => existsSync(join(p.legacyConfig, f)));
  if (!existsSync(p.configFile) && legacy) {
    // A config.toml written now would make `turno migrate` refuse; migrate detects the same list.
    if (merged.length) io.out(`config: no config.toml yet; turno migrate records nerd_terminals = [${merged.join(", ")}]`);
  } else if (merged.join() !== [...current].sort().join()) {
    const text = existsSync(p.configFile) ? readFileSync(p.configFile, "utf8") : "";
    journal.write(p.configFile, withNerdTerminals(text, merged));
    io.out(`config: nerd_terminals = [${merged.join(", ")}] in ${tildify(p.configFile, env)}${dry}`);
  }
  const hint = journal.hint();
  if (hint) io.out(hint);
  return 0;
}

export const command = group(
  "ui",
  "the status line, its font and icons in every terminal",
  {
    status: { summary: "font, status line and icons, terminal by terminal", run: status },
    install: {
      summary: "set up the turno look of Claude Code (font, status line, terminals)",
      synopsis: "[--terminal <ids>] [--no-font] [--no-statusline] [--force] [--dry-run]",
      flags: flagsOf(INSTALL_SPEC),
      details: INSTALL_HELP,
      run: install,
    },
  },
  {
    fallback: "status",
    footer: "turno ui install --help explains each option.",
    examples: [
      "turno ui status",
      "turno ui install --dry-run",
      "turno ui install --terminal warp,vscode --no-font",
    ],
  },
);
