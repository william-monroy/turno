/** Small helpers shared by command modules. Keep this file free of heavy imports. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Io {
  out: (line?: string) => void;
  err: (line?: string) => void;
  env: NodeJS.ProcessEnv;
  isTty: boolean;
}

export function defaultIo(): Io {
  return {
    out: (line = "") => process.stdout.write(`${line}\n`),
    err: (line = "") => process.stderr.write(`${line}\n`),
    env: process.env,
    isTty: Boolean(process.stdout.isTTY),
  };
}

/** What a positional argument holds, for shell completion. */
export type ArgKind = "profile" | "profile-or-auto" | "dir" | "identity" | "server" | "stamp" | "terminal" | "key" | "shell" | "any";

/** Completion data of a command or subcommand. */
export interface Completion {
  args?: ArgKind[];
  /** Long flags, with the leading dashes. */
  flags?: string[];
}

/** A command module: `export const command: Command = { ... }`. */
export interface Command extends Completion {
  /** One line for `claudio help`. */
  summary: string;
  usage: string;
  hidden?: boolean;
  /** Subcommand names (visible ones) with their completion data. */
  subcommands?: Record<string, Completion>;
  run(args: string[], io: Io): Promise<number>;
}

export function paint(io: Io, text: string, code: string): string {
  return io.isTty && !io.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function fail(message: string): never {
  throw new UsageError(message);
}
