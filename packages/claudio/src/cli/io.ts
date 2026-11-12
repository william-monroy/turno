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

/** A command module: `export const command: Command = { ... }`. */
export interface Command {
  /** One line for `claudio help`. */
  summary: string;
  usage: string;
  hidden?: boolean;
  run(args: string[], io: Io): Promise<number>;
}

export function paint(io: Io, text: string, code: string): string {
  return io.isTty && !io.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function fail(message: string): never {
  throw new UsageError(message);
}
