#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enableCompileCache } from "./compile-cache.js";
import { Exit, exitName } from "./exit.js";
import {
  CliError,
  type ColorMode,
  type Io,
  UsageError,
  closest,
  defaultIo,
  fail,
  isColorMode,
  noInputReason,
  paint,
  withoutAsk,
} from "./io.js";
import { COMMANDS, HELP_SUMMARY, HELP_TOPICS, QUIET, SECTIONS, expand, visibleCommands } from "./registry.js";

async function help(io: Io): Promise<number> {
  const sections = await Promise.all(
    SECTIONS.map(async (s) => ({
      title: s.title,
      rows: await Promise.all(
        s.commands.map(async (n) => [n, HELP_SUMMARY[n] ?? (await COMMANDS[n]!()).command.summary] as const),
      ),
    })),
  );
  const { renderHelp } = await import("./help.js");
  for (const line of renderHelp(io, sections)) io.out(line);
  return 0;
}

/** Error classes whose message is the whole story: printed without a stack trace. */
const ONE_LINE_ERRORS = new Set(["ConfigError", "SecretError", "StateError"]);

/** Commands whose arguments belong to the agent they start: only a first --help is theirs. */
const PASSTHROUGH = new Set(["run", "auto", "hook", "statusline", "__complete"]);

function asksHelp(name: string, rest: string[]): boolean {
  if (PASSTHROUGH.has(name)) return rest[0] === "--help" || rest[0] === "-h";
  const end = rest.indexOf("--");
  return (end < 0 ? rest : rest.slice(0, end)).some((a) => a === "--help" || a === "-h");
}

function unknownCommand(word: string): never {
  const near = closest(word, visibleCommands());
  return fail(
    near ? `unknown command '${word}'. Did you mean 'turno ${near}'?` : `unknown command '${word}' (turno --help)`,
  );
}

/** `turno help <command> [sub]`: the same text as `turno <command> [sub] --help`; or a topic. */
async function helpFor(words: string[], io: Io): Promise<number> {
  if (HELP_TOPICS.includes(words[0]!)) {
    const { TOPICS } = await import("./topics.js");
    for (const line of TOPICS[words[0]!]!.text()) io.out(line);
    return 0;
  }
  const [name, rest] = expand(words[0]!, words.slice(1));
  const load = COMMANDS[name];
  if (!load) return unknownCommand(words[0]!);
  const { command } = await load();
  if (rest.length && command.subcommands) return command.run([...rest, "--help"], io);
  io.out(command.usage);
  return 0;
}

/** Print the update notice on stderr after an interactive command, at most once a day. */
async function notice(name: string, io: Io): Promise<void> {
  if (QUIET.has(name) || !io.isTty || !process.stderr.isTTY) return;
  try {
    const { loadConfig } = await import("../core/config.js");
    const { updateNotice } = await import("../core/update.js");
    let configured = true;
    try {
      configured = loadConfig(io.env).updateCheck;
    } catch {
      /* default */
    }
    const text = updateNotice(io.env, configured);
    if (text) io.err(`\n${text}`);
  } catch {
    /* never fail a command over the notice */
  }
}

/**
 * Take the global --no-input flag out of argv: before the command, or among a command's own
 * flags (not after --, and not for commands whose arguments belong to an agent).
 */
export function takeNoInput(argv: string[]): { argv: string[]; noInput: boolean } {
  let i = 0;
  while (argv[i] === "--no-input") i++;
  const [head, ...tail] = argv.slice(i);
  if (head === undefined) return { argv: [], noInput: i > 0 };
  const name = expand(head, [])[0];
  if (!COMMANDS[name] || PASSTHROUGH.has(name)) return { argv: [head, ...tail], noInput: i > 0 };
  const end = tail.indexOf("--");
  const own = end < 0 ? tail : tail.slice(0, end);
  const kept = own.filter((a) => a !== "--no-input");
  return { argv: [head, ...kept, ...(end < 0 ? [] : tail.slice(end))], noInput: i > 0 || kept.length < own.length };
}

function colorValue(v: string | undefined): ColorMode {
  if (isColorMode(v)) return v;
  return fail(
    v === undefined || v.startsWith("-")
      ? "--color needs a value: auto, always or never"
      : `--color ${v}: use auto, always or never`,
  );
}

/**
 * Take the global `--color auto|always|never` (or `--color=<mode>`) out of argv, like --no-input:
 * before the command, or among a command's own flags (not after --, and not for commands whose
 * arguments belong to an agent). Among a command's flags only those three values count, so
 * `turno profile add work --color green` keeps its own --color. The last one given wins.
 */
export function takeColor(argv: string[]): { argv: string[]; color?: ColorMode } {
  const lead: string[] = [];
  let color: ColorMode | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-input") lead.push(a);
    else if (a === "--color") color = colorValue(argv[++i]);
    else if (a.startsWith("--color=")) color = colorValue(a.slice("--color=".length));
    else break;
  }
  const at = <T extends object>(o: T) => (color ? { ...o, color } : o);
  const [head, ...tail] = argv.slice(i);
  if (head === undefined) return at({ argv: lead });
  const name = expand(head, [])[0];
  if (!COMMANDS[name] || PASSTHROUGH.has(name)) return at({ argv: [...lead, head, ...tail] });
  const end = tail.indexOf("--");
  const own = end < 0 ? tail : tail.slice(0, end);
  const kept: string[] = [];
  for (let j = 0; j < own.length; j++) {
    const a = own[j]!;
    const inline = a.startsWith("--color=") ? a.slice("--color=".length) : undefined;
    if (a === "--color" && isColorMode(own[j + 1])) color = own[++j] as ColorMode;
    else if (isColorMode(inline)) color = inline;
    else kept.push(a);
  }
  return at({ argv: [...lead, head, ...kept, ...(end < 0 ? [] : tail.slice(end))] });
}

/** Whether this run asked for --json: then an error is a JSON line on stderr (ADR 0045). */
function wantsJson(argv: string[]): boolean {
  const [head, ...tail] = argv;
  if (!head || head.startsWith("-") || head === "help") return false;
  const [name, rest] = expand(head, tail);
  if (!COMMANDS[name] || PASSTHROUGH.has(name)) return false;
  const end = rest.indexOf("--");
  return (end < 0 ? rest : rest.slice(0, end)).some((a) => a === "--json" || a.startsWith("--json="));
}

/** Print an error the way the run asked (a `turno:` line, or JSON under --json) and return its exit code. */
async function report(err: unknown, io: Io, json: boolean): Promise<number> {
  const e = err as Error;
  const code = err instanceof UsageError ? Exit.usage : err instanceof CliError ? err.code : Exit.failure;
  // Errors that explain themselves in one line; anything else is a bug and keeps its stack.
  const known = err instanceof UsageError || err instanceof CliError || ONE_LINE_ERRORS.has(e?.name);
  if (json) {
    const { jsonError } = await import("./output.js");
    const fields = (err as { fields?: unknown }).fields;
    io.err(
      jsonError(e?.message ?? String(err), code, exitName(code), {
        ...(Array.isArray(fields) ? { fields } : {}),
        ...(known ? {} : { stack: e?.stack }),
      }),
    );
  } else io.err(`turno: ${known ? e.message : (e?.stack ?? e?.message ?? String(err))}`);
  return code;
}

export async function main(args: string[], io: Io = defaultIo()): Promise<number> {
  let picked: ReturnType<typeof takeColor>;
  try {
    picked = takeColor(args);
  } catch (err) {
    io.err(`turno: ${(err as Error).message}`);
    return Exit.usage;
  }
  if (picked.color) io = { ...io, color: picked.color };
  const { argv, noInput } = takeNoInput(picked.argv);
  // --no-input is TURNO_NO_INPUT=1, also for the turno processes this one starts.
  if (noInput) io = { ...withoutAsk(io), env: { ...io.env, TURNO_NO_INPUT: "1" } };
  else if (io.ask && noInputReason(io.env)) io = withoutAsk(io);
  const [head, ...tail] = argv;
  let json = false;
  try {
    json = wantsJson(argv);
    if (!head) {
      // Once turno is set up, bare `turno` is the status screen; before that, the help.
      const { homeScreen } = await import("./commands/status.js");
      const code = await homeScreen(io);
      if (code !== undefined) {
        io.out(paint(io, "turno help lists every command.", "2"));
        return code;
      }
      return await help(io);
    }
    if (head === "-h" || head === "--help") return await help(io);
    if (head === "help") return tail.length ? await helpFor(tail, io) : await help(io);
    if (head === "--version" || head === "-v") {
      const { packageInfo } = await import("../core/version.js");
      io.out(`turno ${packageInfo().version}`);
      return 0;
    }
    if (head.startsWith("-")) return fail(`unknown option ${head} (turno --help)`);
    const [first, rest] = expand(head, tail);
    const load = COMMANDS[first];
    if (load) {
      const { command } = await load();
      if (!command.subcommands && asksHelp(first, rest)) {
        io.out(command.usage);
        return 0;
      }
      if (command.json && !PASSTHROUGH.has(first)) {
        const { answerFields } = await import("./output.js");
        if (answerFields(rest, command.json, io)) return 0;
      }
      const code = await command.run(rest, io);
      await notice(first, io);
      return code;
    }
    // Anything else is a profile name: exec its launcher. A typo of a command is not one.
    const { launchProfile, launcherPath } = await import("./launch.js");
    if (!launcherPath(first, io.env) && closest(first, visibleCommands())) unknownCommand(first);
    return await launchProfile(first, rest, io);
  } catch (err) {
    return report(err, io, json);
  }
}

function isEntry(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  // Before the first command module loads, so it and everything it imports come from the cache.
  let argv = process.argv.slice(2);
  try {
    argv = takeNoInput(takeColor(argv).argv).argv;
  } catch {
    /* main reports the bad --color */
  }
  enableCompileCache(argv);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`turno: ${(err as Error).stack ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
