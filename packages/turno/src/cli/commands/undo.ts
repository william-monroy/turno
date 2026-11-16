import { type JournalInfo, PRUNE_DEFAULT_AGE_MS, PRUNE_DEFAULT_KEEP, listJournals, parseAge, pruneJournals, undoJournal } from "../../core/journal.js";
import { tildify } from "../../core/paths.js";
import { DRY_RUN, FORCE, JSON_FLAG, type Parsed, bool, count, parseFlags, printJson, str } from "../args.js";
import { type Command, type Io, fail, paint } from "../io.js";

const USAGE = `Usage:
  turno undo --list [-n N] [--json]    recent changes, newest first
  turno undo <stamp|last> [--dry-run] [--force]
                                       put back every file that change touched
  turno undo --prune [--older-than 30d] [--keep 10] [--dry-run] [--json]
                                       delete old backups

Every command that writes your files (ui install, profile, config, mcp sync,
mcp daemon, identity, uninstall) keeps a copy under
~/.local/state/turno/backups/<stamp>/ first. A file that changed again after
that command is left alone unless --force. An undo is itself recorded, so it can
be undone.

profile add and profile repair also record the links, launchers and folders
they create and the files they move to .aside-<time>/: undo removes those links
and launchers, moves your files back and removes the .aside-* folder. A profile
folder is removed only when it is empty again; one that holds a login stays.
turno uninstall is recorded the same way, so undo puts back what it removed.

Backups can hold secrets that were in those files, so they are private (folders
0700, files 0600) and pruned: each new backup deletes those older than 30 days,
keeping the newest 10. A backup that is still the only way back for a file it
changed (the file is unchanged since) is kept.`;

function prune(p: Parsed, io: Io): number {
  let olderThanMs = PRUNE_DEFAULT_AGE_MS;
  const age = str(p, "older-than");
  if (age !== undefined) {
    try {
      olderThanMs = parseAge(age);
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  const keepText = str(p, "keep");
  const keep = keepText === undefined ? PRUNE_DEFAULT_KEEP : Number(keepText);
  if (!Number.isInteger(keep) || keep < 0) return fail("--keep must be a whole number");
  const dry = bool(p, "dry-run");
  const r = pruneJournals(io.env, { olderThanMs, keep, dryRun: dry });
  if (bool(p, "json")) {
    printJson(io.out, { dryRun: dry, pruned: r.pruned, kept: r.kept.map((k) => ({ stamp: k.stamp, path: tildify(k.path, io.env) })) });
    return 0;
  }
  const verb = dry ? "would delete" : "deleted";
  if (!r.pruned.length) io.out("No backups to prune.");
  else io.out(`${verb} ${r.pruned.length} backup${r.pruned.length === 1 ? "" : "s"}: ${r.pruned.join(" ")}`);
  for (const k of r.kept) io.out(`kept ${k.stamp}: still undoable (${tildify(k.path, io.env)} is unchanged since)`);
  return 0;
}

function describe(j: JournalInfo, io: Io): string {
  if (!j.manifest) return `${j.stamp}  ${paint(io, "(older backup without a journal: restore by hand)", "2")}`;
  const m = j.manifest;
  const undone = m.undoneBy ? paint(io, `  undone by ${m.undoneBy}`, "2") : "";
  const n = m.entries.length;
  const what = m.entries.every((e) => (e.kind ?? "file") === "file") ? `${n} file${n === 1 ? "" : "s"}` : `${n} change${n === 1 ? "" : "s"}`;
  return `${j.stamp}  ${m.command}  (${what})${undone}`;
}

export const command: Command = {
  summary: "list recent changes turno made to your files, and put any of them back",
  usage: USAGE,
  args: ["stamp"],
  flags: ["--list", "--dry-run", "--force", "--json", "--tail", "--prune", "--older-than", "--keep"],
  async run(args, io) {
    const p = parseFlags(
      args,
      { list: { type: "boolean" }, prune: { type: "boolean" }, "older-than": { type: "string" }, keep: { type: "string" }, ...DRY_RUN, ...FORCE, ...JSON_FLAG, tail: { type: "string", short: "n" } },
      1,
    );
    if (bool(p, "prune")) {
      if (p.positionals.length) return fail("--prune takes no stamp");
      return prune(p, io);
    }
    if (str(p, "older-than") !== undefined || str(p, "keep") !== undefined) return fail("--older-than and --keep go with --prune");
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
      const what = {
        restore: "restored",
        delete: "removed",
        skip: paint(io, "skipped", "33"),
        unlink: "removed link",
        link: "linked again",
        move: "moved back",
        rmdir: "removed folder",
        mkdir: "made folder",
        keep: "kept",
      }[s.action];
      const from = s.from ? ` from ${tildify(s.from, io.env)}` : "";
      io.out(`  ${what} ${tildify(s.path, io.env)}${from}${s.reason ? `: ${s.reason}` : ""}`);
    }
    if (result.journal.used) io.out(`redo with: turno undo ${result.journal.stamp}`);
    return result.steps.some((s) => s.action === "skip") ? 1 : 0;
  },
};
