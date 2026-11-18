/**
 * The exit codes turno promises, for scripts, hooks and status lines. Keep this file
 * free of imports: io.ts and every command load it.
 */
export const Exit = {
  /** Done. */
  ok: 0,
  /** It did not work: the message says why. */
  failure: 1,
  /** The command line was wrong (unknown command or flag, missing argument, a question nobody can answer). */
  usage: 2,
  /** No profile for the folder: no rule and no default, or a rule naming a profile that does not exist. */
  noProfile: 3,
  /** The profile exists but its account is not signed in. */
  notSignedIn: 4,
  /** The gateway (mcpd) does not answer. */
  gatewayDown: 5,
  /** The agent's own command is not installed (the shell's "command not found"). */
  notInstalled: 127,
  /** Cancelled by the person (Ctrl-C or Esc in a picker), as shells report SIGINT. */
  cancelled: 130,
} as const;

/** The stable name of each code, as `--json` errors carry it (`"code": "no_profile"`). */
const NAMES: Readonly<Record<number, string>> = {
  0: "ok",
  1: "failure",
  2: "usage",
  3: "no_profile",
  4: "not_signed_in",
  5: "gateway_down",
  127: "not_installed",
  130: "cancelled",
};

/** The name of an exit code; "failure" for a code outside the contract. */
export function exitName(code: number): string {
  return NAMES[code] ?? "failure";
}

/** One row per code for `turno help exit-codes`: code, name, meaning. */
export const EXIT_ROWS: readonly (readonly [number, string, string])[] = [
  [Exit.ok, "ok", "done"],
  [Exit.failure, "failure", "it did not work; the message on stderr says why"],
  [
    Exit.usage,
    "usage",
    "the command line was wrong: an unknown command or flag, a missing argument, or a question nobody can answer (no terminal, --no-input)",
  ],
  [
    Exit.noProfile,
    "no_profile",
    "no profile for this folder: no rule and no default, or a rule naming a profile that does not exist (turno auto, turno profile which --check)",
  ],
  [
    Exit.notSignedIn,
    "not_signed_in",
    "the folder's profile exists but its account is not signed in (turno profile which --check)",
  ],
  [
    Exit.gatewayDown,
    "gateway_down",
    "the gateway (mcpd) does not answer (turno mcp daemon status, turno mcp top, turno mcp savings)",
  ],
  [Exit.notInstalled, "not_installed", "the agent's own command is not installed (turno auto with no profile to open)"],
  [Exit.cancelled, "cancelled", "cancelled by you: Ctrl-C, or Esc in a profile list"],
];
