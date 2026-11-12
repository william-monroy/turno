import { type JournalInfo, listJournals, undoJournal } from "../../core/journal.js";
import { tildify } from "../../core/paths.js";
import { DRY_RUN, FORCE, JSON_FLAG, bool, count, parseFlags, printJson } from "../args.js";
import { type Command, type Io, fail, paint } from "../io.js";

const USAGE = `Usage:
  turno undo --list [-n N] [--json]       recent changes, newest first
  turno undo <stamp|last> [--dry-run] [--force]
                                            put back every file that change touched

Every command that writes your files (ui install, migrate, profile, config, mcp sync, identity)
keeps a copy under ~/.local/state/turno/backups/<stamp>/ first. A file that changed again
after that command is left alone unless --force. An undo is itself recorded, so it can be undone.`;

function describe(j: JournalInfo, io: Io): string {
  if (!j.manifest) return `${j.stamp}  ${paint(io, "(older backup without a journal: restore by hand)", "2")}`;
  const m = j.manifest;
  const undone = m.undoneBy ? paint(io, `  undone by ${m.undoneBy}`, "2") : "";
  return `${j.stamp}  ${m.command}  (${m.entries.length} file${m.entries.length === 1 ? "" : "s"})${undone}`;
}

export const command: Command = {
  summary: "list recent changes turno made to your files, and put any of them back",
  usage: USAGE,
  args: ["stamp"],
  flags: ["--list", "--dry-run", "--force", "--json", "--tail"],
  async run(args, io) {
    const p = parseFlags(args, { list: { type: "boolean" }, ...DRY_RUN, ...FORCE, ...JSON_FLAG, tail: { type: "string", short: "n" } }, 1);
    const all = listJournals(io.env);
    const target = p.positionals[0];
    if (bool(p, "list") || !target) {
      const shown = all.slice(0, count(p, "tail", 10));
      if (bool(p, "json")) {
        printJson(io.out, shown.map((j) => ({ stamp: j.stamp, command: j.manifest?.command ?? null, files: j.manifest?.entries.map((e) => tildify(e.path, io.env)) ?? null, undoneBy: j.manifest?.undoneBy ?? null })));
        return 0;
      }
      if (!shown.length) io.out("No changes recorded yet.");
      for (const j of shown) io.out(describe(j, io));
      if (!target && shown.length) io.out(`\nturno undo <stamp> puts one back (turno undo last: the newest).`);
      return 0;
    }
    const info = target === "last" ? all.find((j) => j.manifest && !j.manifest.undoneBy) : all.find((j) => j.stamp === target);
    if (!info) return fail(target === "last" ? "nothing to undo" : `no change ${target} (turno undo --list)`);
    if (info.manifest?.undoneBy && !bool(p, "force")) fail(`${info.stamp} was already undone by ${info.manifest.undoneBy} (turno undo ${info.manifest.undoneBy} redoes it)`);
    const dry = bool(p, "dry-run");
    let result;
    try {
      result = undoJournal(info, io.env, { dryRun: dry, force: bool(p, "force") });
    } catch (err) {
      return fail((err as Error).message);
    }
    const d = dry ? " (dry run)" : "";
    io.out(`undo ${info.stamp}: ${info.manifest!.command}${d}`);
    for (const s of result.steps) {
      const what = { restore: "restored", delete: "removed", skip: paint(io, "skipped", "33") }[s.action];
      io.out(`  ${what} ${tildify(s.path, io.env)}${s.reason ? `: ${s.reason}` : ""}`);
    }
    if (result.journal.used) io.out(`redo with: turno undo ${result.journal.stamp}`);
    return result.steps.some((s) => s.action === "skip") ? 1 : 0;
  },
};
