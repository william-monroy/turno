import { type Command, type Completion, type Io, fail } from "./io.js";

export interface Sub extends Completion {
  /** Arguments after the subcommand name, for the usage line. */
  synopsis?: string;
  summary: string;
  hidden?: boolean;
  run(args: string[], io: Io): Promise<number>;
}

/** Usage text of a group: one line per visible subcommand, then an optional footer. */
export function groupUsage(name: string, subs: Record<string, Sub>, footer?: string): string {
  const rows = Object.entries(subs)
    .filter(([, s]) => !s.hidden)
    .map(([n, s]) => [`turno ${name} ${n}${s.synopsis ? ` ${s.synopsis}` : ""}`, s.summary] as const);
  const w = Math.min(60, Math.max(...rows.map(([l]) => l.length)));
  const lines = rows.map(([l, s]) => (l.length > w ? `  ${l}\n  ${" ".repeat(w)}  ${s}` : `  ${l.padEnd(w)}  ${s}`));
  return `Usage:\n${lines.join("\n")}${footer ? `\n\n${footer}` : ""}`;
}

/**
 * A command made of subcommands: `turno <name> <sub> [args]`. `fallback` runs when no
 * subcommand is given (usually `list` or `show`). `--help` after a subcommand prints the group usage.
 */
export function group(name: string, summary: string, subs: Record<string, Sub>, opts: { fallback?: string; footer?: string } = {}): Command {
  const usage = groupUsage(name, subs, opts.footer);
  const subcommands = Object.fromEntries(
    Object.entries(subs)
      .filter(([, s]) => !s.hidden)
      .map(([n, s]) => [n, { ...(s.args ? { args: s.args } : {}), ...(s.flags ? { flags: s.flags } : {}) }]),
  );
  return {
    summary,
    usage,
    subcommands,
    async run(args, io) {
      let [sub, ...rest] = args;
      if (sub === undefined || (sub.startsWith("-") && sub !== "-h" && sub !== "--help" && opts.fallback)) {
        if (!opts.fallback) {
          io.out(usage);
          return 0;
        }
        if (sub !== undefined) rest = args;
        sub = opts.fallback;
      }
      if (sub === "-h" || sub === "--help" || sub === "help") {
        io.out(usage);
        return 0;
      }
      const s = subs[sub];
      if (!s) return fail(`unknown ${name} command '${sub}'\n\n${usage}`);
      if (rest.includes("--help") || rest.includes("-h")) {
        io.out(groupUsage(name, { [sub]: s }));
        return 0;
      }
      return s.run(rest, io);
    },
  };
}
