import { loadRegistry } from "../../accounts/registry.js";
import { loadConfig } from "../../core/config.js";
import { listJournals } from "../../core/journal.js";
import { loadManifest } from "../../core/manifest.js";
import { listProfiles } from "../../core/profiles.js";
import { NAMED_COLORS } from "../../statusline/render.js";
import { TERMINALS } from "../../ui/terminals.js";
import type { ArgKind, Command, Completion } from "../io.js";
import { COMMANDS, SECTIONS, expand } from "../registry.js";

/** Values a flag takes, completed after the flag. */
const FLAG_VALUES: Record<string, ArgKind | string[]> = {
  "--terminal": [...TERMINALS.filter((t) => t.write).map((t) => t.id), "current", "all"],
  "--browser": ["chrome", "default"],
  "--profile": "profile",
  "--channel": ["latest", "next"],
  "--color": Object.keys(NAMED_COLORS).filter((c) => /^[a-z]+$/.test(c)),
};

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

async function values(kind: ArgKind | string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (Array.isArray(kind)) return kind;
  const profiles = () => safe(() => listProfiles(loadConfig(env), env), []);
  switch (kind) {
    case "profile":
      return profiles();
    case "profile-or-auto":
      return [...profiles(), "auto"];
    case "identity": {
      const services = safe(() => Object.keys(loadRegistry(env).accounts), []);
      let browsers: string[] = [];
      try {
        const { loadBrowser } = await import("./browser.js");
        const mod = await loadBrowser();
        browsers = mod ? mod.listIdentities(env).map((i) => `browser:${i.id}`) : [];
      } catch {
        browsers = [];
      }
      return [...services, ...browsers];
    }
    case "server":
      return safe(() => Object.keys(loadManifest(env).servers), []);
    case "stamp":
      return ["last", ...listJournals(env).filter((j) => j.manifest).map((j) => j.stamp)];
    case "key": {
      const { CONFIG_KEYS } = await import("./config.js");
      return CONFIG_KEYS.flatMap((k) =>
        k.includes("<name>") ? profiles().map((p) => k.replace("<name>", p)) : k.includes("<agent>") ? ["codex", "copilot", "cursor"].map((a) => k.replace("<agent>", a)) : [k],
      );
    }
    case "shell":
      return ["zsh", "bash", "fish"];
    case "terminal":
      return FLAG_VALUES["--terminal"] as string[];
    default:
      return [];
  }
}

/** Candidates for the last word, given the words before it (both after `turno`). */
export async function complete(words: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const cur = words[words.length - 1] ?? "";
  const before = words.slice(0, -1);
  const match = (list: string[]) => [...new Set(list)].filter((c) => c.startsWith(cur));
  if (before.length === 0) {
    const visible = SECTIONS.flatMap((s) => s.commands);
    const profiles = safe(() => listProfiles(loadConfig(env), env), []);
    return match([...visible, ...profiles]);
  }
  const [name, rest] = expand(before[0]!, before.slice(1));
  const load = COMMANDS[name];
  if (!load) return []; // a profile: the rest belongs to claude
  const cmd: Command = (await load()).command;
  let comp: Completion = cmd;
  let args = rest;
  if (cmd.subcommands) {
    if (args.length === 0) return match(Object.keys(cmd.subcommands));
    comp = cmd.subcommands[args[0]!] ?? {};
    args = args.slice(1);
  }
  const prev = before[before.length - 1]!;
  const flagValue = FLAG_VALUES[prev];
  if (flagValue && comp.flags?.includes(prev)) return match(await values(flagValue, env));
  if (cur.startsWith("-")) return match(comp.flags ?? []);
  const positionals = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && FLAG_VALUES[args[i - 1]!]));
  const kinds = comp.args ?? [];
  const kind = kinds[positionals.length] ?? (kinds[kinds.length - 1] === "profile" && kinds.length === 1 && name === "profile" ? "profile" : undefined);
  if (!kind) return [];
  if (kind === "dir") return [":dir"];
  return match(await values(kind, env));
}

export const command: Command = {
  summary: "completion candidates for the shell scripts",
  usage: "Usage: turno __complete -- <words...>",
  hidden: true,
  async run(args, io) {
    const words = args[0] === "--" ? args.slice(1) : args;
    for (const c of await complete(words.length ? words : [""], io.env)) io.out(c);
    return 0;
  },
};
