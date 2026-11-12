#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Io, UsageError, defaultIo } from "./io.js";
import { COMMANDS, QUIET, SECTIONS, expand } from "./registry.js";

async function help(io: Io): Promise<number> {
  io.out("claudio: several Claude Code accounts on one machine, sharing context, with a lazy MCP gateway.\n");
  io.out("Usage:");
  io.out(`  claudio ${"<profile> [claude args]".padEnd(24)} open Claude Code with that account (claudio run <profile>)`);
  for (const section of SECTIONS) {
    io.out(`\n${section.title}:`);
    const loaded = await Promise.all(section.commands.map(async (n) => [n, (await COMMANDS[n]!()).command] as const));
    for (const [name, cmd] of loaded) io.out(`  claudio ${name.padEnd(24)} ${cmd.summary}`);
  }
  io.out("\nRun `claudio <command> --help` for details. Older names (setup, usage, exhausted, accounts, mcpd,");
  io.out("and the Spanish ones) still work.");
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
  if (!head || head === "help" || head === "-h" || head === "--help") return help(io);
  if (head === "--version" || head === "-v") {
    const { packageInfo } = await import("../core/version.js");
    io.out(`claudio ${packageInfo().version}`);
    return 0;
  }
  const [first, rest] = expand(head, tail);
  const load = COMMANDS[first];
  try {
    if (load) {
      const { command } = await load();
      if (!command.subcommands && (rest[0] === "--help" || rest[0] === "-h")) {
        io.out(command.usage);
        return 0;
      }
      const code = await command.run(rest, io);
      await notice(first, io);
      return code;
    }
    // Anything else is a profile name: exec its launcher.
    const { launchProfile } = await import("./launch.js");
    return await launchProfile(first, rest, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`claudio: ${err.message}`);
      return 2;
    }
    const e = err as Error;
    io.err(`claudio: ${e.name === "ConfigError" ? e.message : (e.stack ?? e.message)}`);
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
      process.stderr.write(`claudio: ${(err as Error).stack ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
