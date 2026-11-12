#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Command, type Io, UsageError, defaultIo } from "./io.js";

/**
 * Command registry. Modules load lazily so hot paths (`auto`, `resolve`, `statusline`)
 * never pay for the MCP SDK. Legacy Spanish names from the original bash script stay as
 * hidden aliases so existing hooks, Orca and status lines keep working.
 */
const COMMANDS: Record<string, () => Promise<{ command: Command }>> = {
  auto: () => import("./commands/auto.js"),
  which: () => import("./commands/which.js"),
  resolve: () => import("./commands/resolve.js"),
  sessions: () => import("./commands/sessions.js"),
  usage: () => import("./commands/usage.js"),
  exhausted: () => import("./commands/exhausted.js"),
  available: () => import("./commands/available.js"),
  hook: () => import("./commands/hook.js"),
  setup: () => import("./commands/setup.js"),
  status: () => import("./commands/status.js"),
  open: () => import("./commands/open.js"),
  migrate: () => import("./commands/migrate.js"),
  doctor: () => import("./commands/doctor.js"),
  statusline: () => import("./commands/statusline.js"),
  handoff: () => import("./commands/handoff.js"),
  mcp: () => import("./commands/mcp.js"),
  mcpd: () => import("./commands/mcpd.js"),
  secret: () => import("./commands/secret.js"),
  accounts: () => import("./commands/accounts.js"),
  browser: () => import("./commands/browser.js"),
};

const ALIASES: Record<string, string[]> = {
  cuenta: ["which"],
  resolver: ["resolve"],
  sesiones: ["sessions"],
  uso: ["usage"],
  agotada: ["exhausted"],
  disponible: ["available"],
  limite: ["hook", "rate-limit"],
  abrir: ["open"],
  "sync-mcp": ["mcp", "sync"],
};

const ALIAS_FLAGS: Record<string, Record<string, string>> = {
  uso: { "--vigilar": "--watch" },
  agotada: { hasta: "until" },
};

async function help(io: Io): Promise<number> {
  io.out("claudio: several Claude Code accounts on one Mac, sharing context, with a lazy MCP gateway.\n");
  io.out("Usage:");
  io.out("  claudio <profile> [claude args]     open Claude Code with that account");
  const names = Object.keys(COMMANDS);
  const loaded = await Promise.all(names.map(async (n) => [n, (await COMMANDS[n]!()).command] as const));
  for (const [name, cmd] of loaded) {
    if (!cmd.hidden) io.out(`  claudio ${name.padEnd(28)} ${cmd.summary}`);
  }
  io.out("\nRun `claudio <command> --help` for details.");
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let [first, ...rest] = argv;
  if (!first || first === "help" || first === "-h" || first === "--help") return help(io);
  if (first === "--version" || first === "-v") {
    io.out("claudio 0.1.0");
    return 0;
  }
  const alias = ALIASES[first];
  if (alias) {
    const flags = ALIAS_FLAGS[first] ?? {};
    rest = [...alias.slice(1), ...rest.map((a) => flags[a] ?? a)];
    first = alias[0]!;
  }
  const load = COMMANDS[first];
  try {
    if (load) {
      const { command } = await load();
      if (rest[0] === "--help" || rest[0] === "-h") {
        io.out(command.usage);
        return 0;
      }
      return await command.run(rest, io);
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
