#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError, type Io, UsageError, WIDTH, closest, columns, defaultIo, fail, wrap } from "./io.js";
import { COMMANDS, HELP_SUMMARY, QUIET, SECTIONS, expand, visibleCommands } from "./registry.js";

async function help(io: Io): Promise<number> {
  for (const l of wrap("turno: one MCP gateway and per-folder accounts for Claude Code, Codex, Copilot CLI and Cursor CLI.", WIDTH)) io.out(l);
  io.out("");
  io.out("Start here: turno doctor, then turno mcp import and turno profile add <name>.");
  io.out("");
  const sections = await Promise.all(
    SECTIONS.map(async (s) => ({
      title: s.title,
      rows: await Promise.all(s.commands.map(async (n) => [`turno ${n}`, HELP_SUMMARY[n] ?? (await COMMANDS[n]!()).command.summary] as const)),
    })),
  );
  const w = Math.max(...sections.flatMap((s) => s.rows.map(([l]) => l.length)));
  io.out("Usage:");
  io.out(columns([["turno <profile>", "open that profile with its agent; the arguments after it go to the agent"]], 2, w, w));
  for (const s of sections) io.out(`\n${s.title}:\n${columns(s.rows, 2, w, w)}`);
  io.out("\nRun turno <command> --help, or turno help <command>, for details.");
  return 0;
}

/** Commands whose arguments belong to the agent they start: only a first --help is theirs. */
const PASSTHROUGH = new Set(["run", "auto", "hook", "statusline", "__complete"]);

function asksHelp(name: string, rest: string[]): boolean {
  if (PASSTHROUGH.has(name)) return rest[0] === "--help" || rest[0] === "-h";
  const end = rest.indexOf("--");
  return (end < 0 ? rest : rest.slice(0, end)).some((a) => a === "--help" || a === "-h");
}

function unknownCommand(word: string): never {
  const near = closest(word, visibleCommands());
  return fail(near ? `unknown command '${word}'. Did you mean 'turno ${near}'?` : `unknown command '${word}' (turno --help)`);
}

/** `turno help <command> [sub]`: the same text as `turno <command> [sub] --help`. */
async function helpFor(words: string[], io: Io): Promise<number> {
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

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [head, ...tail] = argv;
  try {
    if (!head || head === "-h" || head === "--help") return await help(io);
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
      const code = await command.run(rest, io);
      await notice(first, io);
      return code;
    }
    // Anything else is a profile name: exec its launcher. A typo of a command is not one.
    const { launchProfile, launcherPath } = await import("./launch.js");
    if (!launcherPath(first, io.env) && closest(first, visibleCommands())) unknownCommand(first);
    return await launchProfile(first, rest, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`turno: ${err.message}`);
      return 2;
    }
    if (err instanceof CliError) {
      io.err(`turno: ${err.message}`);
      return err.code;
    }
    const e = err as Error;
    io.err(`turno: ${e.name === "ConfigError" ? e.message : (e.stack ?? e.message)}`);
    return 1;
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
