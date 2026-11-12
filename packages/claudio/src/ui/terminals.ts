import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_SYMBOLS, type TerminalId } from "./terminal-id.js";

/**
 * What claudio knows about each terminal: where its font is set and how to change it. Only
 * plain-text configs are edited (TOML and the JSONC of VS Code and Cursor); for the others the
 * font is a setting in the app, and `manual` says where.
 */
export interface Terminal {
  id: TerminalId;
  name: string;
  /** Draws Nerd Font icons with any font (ships the symbols). */
  symbols: boolean;
  /** Config file that holds the font, when it is a file claudio can edit. */
  config?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string;
  read?: (text: string) => string | undefined;
  write?: (text: string, family: string) => string;
  manual?: string;
  /** App bundle under /Applications that tells whether it is installed. */
  app?: string;
}

const home = (env: NodeJS.ProcessEnv) => env.HOME ?? "";
const xdg = (env: NodeJS.ProcessEnv) => env.XDG_CONFIG_HOME || join(home(env), ".config");

/** A Nerd Font family name: patched fonts carry "NF" or "Nerd Font" in the name. */
export function isNerdFamily(family: string | undefined): boolean {
  return Boolean(family && /(\bNF\b|\bNFM\b|\bNFP\b|Nerd Font)/i.test(family));
}

// TOML: set or read one key inside one [section], keeping the rest of the file as written.

function tomlSection(lines: string[], section: string): [number, number] | undefined {
  const header = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (header < 0) return undefined;
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  return [header, end];
}

export function tomlGet(text: string, section: string, key: string): string | undefined {
  const lines = text.split("\n");
  const range = tomlSection(lines, section);
  if (!range) return undefined;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  for (let i = range[0] + 1; i < range[1]; i++) {
    const m = re.exec(lines[i]!);
    if (m) return JSON.parse(`"${m[1]}"`) as string;
  }
  return undefined;
}

export function tomlSet(text: string, section: string, key: string, value: string): string {
  const lines = text.split("\n");
  const entry = `${key} = ${JSON.stringify(value)}`;
  const range = tomlSection(lines, section);
  if (!range) {
    const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${body.trim() ? "\n" : ""}[${section}]\n${entry}\n`;
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = range[0] + 1; i < range[1]; i++) {
    if (re.test(lines[i]!)) {
      lines[i] = entry;
      return lines.join("\n");
    }
  }
  // After the section's last non-blank line.
  let at = range[1];
  while (at > range[0] + 1 && lines[at - 1]!.trim() === "") at--;
  lines.splice(at, 0, entry);
  return lines.join("\n");
}

// JSONC (VS Code, Cursor): replace a top-level string value in place, or add it after "{".

const jsonKey = (key: string) => new RegExp(`("${key.replace(/\./g, "\\.")}"\\s*:\\s*)"((?:[^"\\\\]|\\\\.)*)"`);

export function jsoncGet(text: string, key: string): string | undefined {
  const m = jsonKey(key).exec(text);
  return m ? (JSON.parse(`"${m[2]}"`) as string) : undefined;
}

export function jsoncSet(text: string, key: string, value: string): string {
  const re = jsonKey(key);
  if (re.test(text)) return text.replace(re, (_all, head: string) => `${head}${JSON.stringify(value)}`);
  const open = text.indexOf("{");
  if (open < 0) return `{\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n}\n`;
  const rest = text.slice(open + 1);
  const empty = rest.trim().startsWith("}");
  return `${text.slice(0, open + 1)}\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}${empty ? "" : ","}${rest}`;
}

const VSCODE_KEY = "terminal.integrated.fontFamily";

function editorSettings(app: string, linuxDir: string) {
  return (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
    platform === "darwin"
      ? join(home(env), "Library", "Application Support", app, "User", "settings.json")
      : join(xdg(env), linuxDir, "User", "settings.json");
}

export const TERMINALS: Terminal[] = [
  {
    id: "warp",
    name: "Warp",
    symbols: false,
    config: (env) => join(home(env), ".warp", "settings.toml"),
    read: (t) => tomlGet(t, "appearance.text", "font_name"),
    write: (t, f) => tomlSet(t, "appearance.text", "font_name", f),
    app: "Warp.app",
  },
  {
    id: "vscode",
    name: "VS Code",
    symbols: false,
    config: editorSettings("Code", "Code"),
    read: (t) => jsoncGet(t, VSCODE_KEY),
    write: (t, f) => jsoncSet(t, VSCODE_KEY, f),
    app: "Visual Studio Code.app",
  },
  {
    id: "cursor",
    name: "Cursor",
    symbols: false,
    config: editorSettings("Cursor", "Cursor"),
    read: (t) => jsoncGet(t, VSCODE_KEY),
    write: (t, f) => jsoncSet(t, VSCODE_KEY, f),
    app: "Cursor.app",
  },
  {
    id: "alacritty",
    name: "Alacritty",
    symbols: false,
    config: (env) => join(xdg(env), "alacritty", "alacritty.toml"),
    read: (t) => tomlGet(t, "font.normal", "family"),
    write: (t, f) => tomlSet(t, "font.normal", "family", f),
    app: "Alacritty.app",
  },
  {
    id: "iterm2",
    name: "iTerm2",
    symbols: false,
    manual: "Settings > Profiles > Text > Font: MesloLGS Nerd Font (iTerm2 rewrites its own preferences, so claudio leaves them alone)",
    app: "iTerm.app",
  },
  {
    id: "apple-terminal",
    name: "Terminal",
    symbols: false,
    manual: "Settings > Profiles > Text > Font > Change: MesloLGS Nerd Font",
  },
  { id: "ghostty", name: "Ghostty", symbols: true, app: "Ghostty.app" },
  { id: "wezterm", name: "WezTerm", symbols: true, app: "WezTerm.app" },
  { id: "kitty", name: "kitty", symbols: true, app: "kitty.app" },
  { id: "orca", name: "Orca", symbols: true },
];

for (const t of TERMINALS) if (t.symbols !== BUILTIN_SYMBOLS.has(t.id)) throw new Error(`terminal table out of sync: ${t.id}`);

export function terminal(id: string): Terminal | undefined {
  return TERMINALS.find((t) => t.id === id);
}

/** Whether a terminal seems installed: its config file or its app bundle exists. */
export function installed(t: Terminal, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (t.config && existsSync(t.config(env, platform))) return true;
  const apps = env.CLAUDIO_APPS_DIR || "/Applications";
  return platform === "darwin" && t.app !== undefined && existsSync(join(apps, t.app));
}

export function fontOf(t: Terminal, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (!t.config || !t.read) return undefined;
  const file = t.config(env, platform);
  if (!existsSync(file)) return undefined;
  try {
    return t.read(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Terminals that need a Nerd Font and have one set in their config file. */
export function detectNerdTerminals(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return TERMINALS.filter((t) => !t.symbols && isNerdFamily(fontOf(t, env, platform))).map((t) => t.id);
}
