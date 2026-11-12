/**
 * Which terminal the status line is drawn in, from the environment alone. The status line
 * calls this on every render, so it stays free of file reads and heavy imports.
 */
export type TerminalId =
  | "warp"
  | "vscode"
  | "cursor"
  | "iterm2"
  | "apple-terminal"
  | "ghostty"
  | "wezterm"
  | "kitty"
  | "alacritty"
  | "orca";

const BY_PROGRAM: Record<string, TerminalId> = {
  WarpTerminal: "warp",
  "iTerm.app": "iterm2",
  Apple_Terminal: "apple-terminal",
  ghostty: "ghostty",
  WezTerm: "wezterm",
  Orca: "orca",
};

/** Terminals that draw Nerd Font icons whatever font is set: they ship the symbols. */
export const BUILTIN_SYMBOLS: ReadonlySet<TerminalId> = new Set(["ghostty", "wezterm", "kitty", "orca"]);

export function currentTerminal(env: NodeJS.ProcessEnv): TerminalId | undefined {
  const program = env.TERM_PROGRAM ?? "";
  if (program === "vscode") {
    const cursor = Boolean(env.CURSOR_TRACE_ID) || (env.__CFBundleIdentifier ?? "").startsWith("com.todesktop.");
    return cursor ? "cursor" : "vscode";
  }
  if (BY_PROGRAM[program]) return BY_PROGRAM[program];
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "kitty";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "alacritty";
  return undefined;
}

/** Whether `auto` icons should be Nerd Font icons in this terminal. */
export function nerdHere(env: NodeJS.ProcessEnv, nerdTerminals: readonly string[]): boolean {
  const id = currentTerminal(env);
  return id !== undefined && (BUILTIN_SYMBOLS.has(id) || nerdTerminals.includes(id));
}
