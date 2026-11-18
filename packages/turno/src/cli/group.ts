import { type Command, type Completion, type Io, closest, columns, examplesBlock, fail } from "./io.js";
import { type JsonOutput, answerFields } from "./output.js";

export interface Sub extends Completion {
  /** Arguments after the subcommand name, for the usage line. */
  synopsis?: string;
  summary: string;
  hidden?: boolean;
  /** The subcommand is itself a command that prints its own help, so `--help` is passed on. */
  ownHelp?: boolean;
  /** More text for `turno <group> <sub> --help`. */
  details?: string;
  /** Its `--json` output, so `--json=fields` answers before it runs (ADR 0045). */
  json?: JsonOutput;
  run(args: string[], io: Io): Promise<number>;
}

/** Usage text of a group: one line per visible subcommand, then an optional footer and examples. */
function groupUsage(
  name: string,
  subs: Record<string, Sub>,
  footer?: string,
  examples: readonly string[] = [],
): string {
  const rows = Object.entries(subs)
    .filter(([, s]) => !s.hidden)
    .map(([n, s]) => [`turno ${name} ${n}${s.synopsis ? ` ${s.synopsis}` : ""}`, s.summary] as const);
  return `Usage:\n${columns(rows, 2, 36)}${footer ? `\n\n${footer}` : ""}${examples.length ? `\n\n${examplesBlock(examples)}` : ""}`;
}

/** The group's examples that run `turno <name> <sub>`, for that subcommand's help. */
function subExamples(name: string, sub: string, examples: readonly string[]): string[] {
  const head = `turno ${name} ${sub}`;
  return examples.filter((e) => e === head || e.startsWith(`${head} `));
}

/**
 * A command made of subcommands: `turno <name> <sub> [args]`. `fallback` runs when no
 * subcommand is given (usually `list` or `show`). `--help` after a subcommand prints its usage,
 * with the group's examples for it.
 */
export function group(
  name: string,
  summary: string,
  subs: Record<string, Sub>,
  opts: { fallback?: string; footer?: string; examples?: readonly string[] } = {},
): Command {
  const examples = opts.examples ?? [];
  const usage = groupUsage(name, subs, opts.footer, examples);
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
            ? `unknown ${name} command '${sub}'. Did you mean 'turno ${name} ${near}'?`
            : `unknown ${name} command '${sub}'\n\n${usage}`,
        );
      }
      if (!s.ownHelp && (rest.includes("--help") || rest.includes("-h"))) {
        io.out(groupUsage(name, { [sub]: s }, s.details, subExamples(name, sub, examples)));
        return 0;
      }
      if (answerFields(rest, s.json, io)) return 0;
      return s.run(rest, io);
    },
  };
}
