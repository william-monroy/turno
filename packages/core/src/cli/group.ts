import { type Command, type Completion, type Io, closest, columns, examplesBlock, fail } from "./io.js";
import { type JsonOutput, answerFields } from "./output.js";

export interface Sub extends Completion {
  /** Arguments after the subcommand name, for the usage line. */
  synopsis?: string;
  summary: string;
  hidden?: boolean;
  /** The subcommand is itself a command that prints its own help, so `--help` is passed on. */
  ownHelp?: boolean;
  /** More text for `<prefix> <sub> --help`. */
  details?: string;
  /** Its `--json` output, so `--json=fields` answers before it runs. */
  json?: JsonOutput;
  run(args: string[], io: Io): Promise<number>;
}

/** Usage text of a group: one line per visible subcommand, then an optional footer and examples. */
function groupUsage(
  prefix: string,
  subs: Record<string, Sub>,
  footer?: string,
  examples: readonly string[] = [],
): string {
  const rows = Object.entries(subs)
    .filter(([, s]) => !s.hidden)
    .map(([n, s]) => [`${prefix} ${n}${s.synopsis ? ` ${s.synopsis}` : ""}`, s.summary] as const);
  return `Usage:\n${columns(rows, 2, 36)}${footer ? `\n\n${footer}` : ""}${examples.length ? `\n\n${examplesBlock(examples)}` : ""}`;
}

/** The group's examples that run `<prefix> <sub>`, for that subcommand's help. */
function subExamples(prefix: string, sub: string, examples: readonly string[]): string[] {
  const head = `${prefix} ${sub}`;
  return examples.filter((e) => e === head || e.startsWith(`${head} `));
}

/**
 * A command made of subcommands: `turno <name> <sub> [args]`. `fallback` runs when no
 * subcommand is given (usually `list` or `show`). `--help` after a subcommand prints its usage,
 * with the group's examples for it. `prefix` is how the group is typed (default `turno <name>`;
 * `turno-browser` for that program's own commands).
 */
export function group(
  name: string,
  summary: string,
  subs: Record<string, Sub>,
  opts: { fallback?: string; footer?: string; examples?: readonly string[]; prefix?: string } = {},
): Command {
  const examples = opts.examples ?? [];
  const prefix = opts.prefix ?? `turno ${name}`;
  const usage = groupUsage(prefix, subs, opts.footer, examples);
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
      if (!s) {
        const near = closest(
          sub,
          Object.keys(subs).filter((n) => !subs[n]!.hidden),
        );
        return fail(
          near
            ? `unknown ${name} command '${sub}'. Did you mean '${prefix} ${near}'?`
            : `unknown ${name} command '${sub}'\n\n${usage}`,
        );
      }
      if (!s.ownHelp && (rest.includes("--help") || rest.includes("-h"))) {
        io.out(groupUsage(prefix, { [sub]: s }, s.details, subExamples(prefix, sub, examples)));
        return 0;
      }
      if (answerFields(rest, s.json, io)) return 0;
      return s.run(rest, io);
    },
  };
}
