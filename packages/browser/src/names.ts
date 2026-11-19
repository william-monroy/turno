/**
 * How the commands a message suggests are typed. turno-browser's own commands work for every
 * install, so messages name them by default (`turno-browser login school`), the MCP server's
 * included. When turno-cli runs the identity commands as `turno browser <cmd>` and
 * `turno identity ... browser:<id>`, its host sets turno's names for that process, so its
 * hints, errors and doctor fixes keep naming the commands the person typed.
 */

/** How the commands are typed, for hints, examples and messages. */
export interface CliNames {
  /** The program, as errors start: `turno-browser` or `turno`. */
  program: string;
  /** How a browser subcommand is typed: `turno-browser` or `turno browser`. */
  browser: string;
  /** The word messages put before a subcommand name: "" or "browser ". */
  subject: string;
  /** How a command on one identity is typed: `turno-browser add school`, `turno identity add browser:school`. */
  identity(sub: string, id: string): string;
  /** How a person stores a secret store item that a `keychain:<item>` reference names. */
  secretSet(item: string): string;
  /** The secret store in short, where a line has no room for `secretSet` (default: `secretSet("<item>")`). */
  secretStore?: string;
}

/** The names of turno-browser on its own. */
export const STANDALONE_NAMES: CliNames = {
  program: "turno-browser",
  browser: "turno-browser",
  subject: "",
  identity: (sub, id) => `turno-browser ${sub} ${id}`,
  secretSet: (item) => `turno-browser secret set ${item}`,
};

let current: CliNames = STANDALONE_NAMES;

/** The names messages of this process use. */
export function names(): CliNames {
  return current;
}

/** Use `n` for the messages of this process (a host's names); `STANDALONE_NAMES` restores. */
export function useNames(n: CliNames): void {
  current = n;
}
