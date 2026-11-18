import {
  type JournalInfo,
  type UndoStep,
  PRUNE_DEFAULT_AGE_MS,
  PRUNE_DEFAULT_KEEP,
  listJournals,
  parseAge,
  pruneJournals,
  undoJournal,
} from "../../core/journal.js";
import { tildify } from "../../core/paths.js";
import { DRY_RUN, FORCE, JSON_FLAG, type Parsed, bool, count, parseFlags, str } from "../args.js";
import { type Command, type Io, fail, paint } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { duration, style } from "../style.js";

/** `undo --list --json` (one element per change) and `undo --prune --json`. */
const LIST_JSON = jsonOutput(["stamp", "command", "files", "undoneBy"]);
const PRUNE_JSON = jsonOutput(["dryRun", "pruned", "kept"]);

const USAGE = `Usage:
  turno undo --list [-n N] [--json]    recent changes, newest first
  turno undo <stamp|last> [--dry-run] [--force] [-v]
                                       put back every file that change touched;
                                       one line per folder, -v lists each change
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
changed (the file is unchanged since) is kept.

Examples:
  $ turno undo --list
  $ turno undo last --dry-run
  $ turno undo 20261117-101500
  $ turno undo --prune --older-than 30d`;

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
    emit(io, p, PRUNE_JSON, {
      dryRun: dry,
      pruned: r.pruned,
      kept: r.kept.map((k) => ({ stamp: k.stamp, path: tildify(k.path, io.env) })),
    });
    return 0;
  }
  const verb = dry ? "would delete" : "deleted";
  if (!r.pruned.length) io.out("No backups to prune.");
  else io.out(`${verb} ${r.pruned.length} backup${r.pruned.length === 1 ? "" : "s"}: ${r.pruned.join(" ")}`);
  for (const k of r.kept) io.out(`kept ${k.stamp}: still undoable (${tildify(k.path, io.env)} is unchanged since)`);
  return 0;
}

/** Paths under HOME inside a sentence, shown with ~. */
function tildifyText(text: string, env: NodeJS.ProcessEnv): string {
  return text
    .split(" ")
    .map((w) => (w.startsWith("/") ? tildify(w, env) : w))
    .join(" ");
}

/** How each undo step reads: alone (with -v), and counted in a folder summary. */
const VERBS: Record<UndoStep["action"], { one: string; done: string; noun: string }> = {
  restore: { one: "restored", done: "restored", noun: "files" },
  delete: { one: "removed", done: "removed", noun: "files" },
  skip: { one: "skipped", done: "skipped", noun: "files" },
  unlink: { one: "removed link", done: "removed", noun: "links" },
  link: { one: "linked again", done: "linked again", noun: "links" },
  move: { one: "moved back", done: "moved back", noun: "files" },
  rmdir: { one: "removed folder", done: "removed", noun: "folders" },
  mkdir: { one: "made folder", done: "made again", noun: "folders" },
  keep: { one: "kept", done: "kept", noun: "folders" },
  chmod: { one: "mode put back", done: "mode put back", noun: "modes" },
};

/** Folders that hold other folders: a summary groups one level below them (~/.config/turno). */
const CONTAINERS = ["Library", ".config", ".local/state", ".local/share", ".local"];

const DIR_ACTIONS = new Set<UndoStep["action"]>(["rmdir", "mkdir", "chmod", "keep"]);

/** The folder a step is summarized under (~/.claude-work, ~/.config/turno, ~/.local/bin), and its path in it. */
function folderOf(step: UndoStep, env: NodeJS.ProcessEnv): { folder: string; rel: string } {
  const t = tildify(step.path, env);
  const isDir = DIR_ACTIONS.has(step.action);
  if (!t.startsWith("~/")) {
    if (isDir) return { folder: t, rel: "" };
    const cut = t.lastIndexOf("/");
    return { folder: t.slice(0, Math.max(1, cut)), rel: t.slice(cut + 1) };
  }
  const parts = t.slice(2).split("/");
  const container = CONTAINERS.find((c) => t.slice(2).startsWith(`${c}/`));
  const depth = container ? container.split("/").length + 1 : 1;
  if (parts.length > depth)
    return { folder: `~/${parts.slice(0, depth).join("/")}`, rel: parts.slice(depth).join("/") };
  if (isDir) return { folder: t, rel: "" };
  return { folder: parts.length > 1 ? `~/${parts.slice(0, -1).join("/")}` : "~", rel: parts[parts.length - 1]! };
}

/** One line per folder: "23 links removed, settings.json moved back". */
export function summarize(
  steps: readonly UndoStep[],
  env: NodeJS.ProcessEnv,
): { folder: string; text: string[]; skipped: boolean }[] {
  const groups = new Map<string, Map<UndoStep["action"], string[]>>();
  for (const s of steps) {
    const { folder, rel } = folderOf(s, env);
    const g = groups.get(folder) ?? new Map<UndoStep["action"], string[]>();
    g.set(s.action, [...(g.get(s.action) ?? []), rel]);
    groups.set(folder, g);
  }
  // Folders in name order, HOME itself last.
  const order = [...groups].sort(([a], [b]) => (a === "~" ? 1 : b === "~" ? -1 : a < b ? -1 : a > b ? 1 : 0));
  return order.map(([folder, g]) => ({
    folder,
    skipped: g.has("skip"),
    text: [...g].map(([action, rels]) => {
      const v = VERBS[action];
      if (rels.length > 1) return `${rels.length} ${v.noun} ${v.done}`;
      const rel = rels[0]!.replace(/^\.aside-[^/]*$/, "aside folder");
      return `${rel || "folder"} ${v.done}`;
    }),
  }));
}

function describe(j: JournalInfo, io: Io): string {
  if (!j.manifest) return `${j.stamp}  ${paint(io, "(older backup without a journal: restore by hand)", "2")}`;
  const m = j.manifest;
  const undone = m.undoneBy ? paint(io, `  undone by ${m.undoneBy}`, "2") : "";
  const n = m.entries.length;
  const what = m.entries.every((e) => (e.kind ?? "file") === "file")
    ? `${n} file${n === 1 ? "" : "s"}`
    : `${n} change${n === 1 ? "" : "s"}`;
  return `${j.stamp}  ${m.command}  (${what})${undone}`;
}

export const command: Command = {
  summary: "list recent changes turno made to your files, and put any of them back",
  usage: USAGE,
  args: ["stamp"],
  flags: ["--list", "--verbose", "--dry-run", "--force", "--json", "--tail", "--prune", "--older-than", "--keep"],
  json: jsonOutput([...LIST_JSON.fields, ...PRUNE_JSON.fields]),
  async run(args, io) {
    const p = parseFlags(
      args,
      {
        list: { type: "boolean" },
        prune: { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        "older-than": { type: "string" },
        keep: { type: "string" },
        ...DRY_RUN,
        ...FORCE,
        ...JSON_FLAG,
        tail: { type: "string", short: "n" },
      },
      1,
    );
    if (bool(p, "prune")) {
      if (p.positionals.length) return fail("--prune takes no stamp");
      return prune(p, io);
    }
    if (str(p, "older-than") !== undefined || str(p, "keep") !== undefined)
      return fail("--older-than and --keep go with --prune");
    const all = listJournals(io.env);
    const target = p.positionals[0];
    if (bool(p, "list") || !target) {
      const shown = all.slice(0, count(p, "tail", 10));
      if (bool(p, "json")) {
        emit(
          io,
          p,
          LIST_JSON,
          shown.map((j) => ({
            stamp: j.stamp,
            command: j.manifest?.command ?? null,
            files: j.manifest?.entries.map((e) => tildify(e.path, io.env)) ?? null,
            undoneBy: j.manifest?.undoneBy ?? null,
          })),
        );
        return 0;
      }
      if (!shown.length) io.out("No changes recorded yet.");
      for (const j of shown) io.out(describe(j, io));
      if (!target && shown.length) io.out(`\nturno undo <stamp> puts one back (turno undo last: the newest).`);
      return 0;
    }
    const info =
      target === "last" ? all.find((j) => j.manifest && !j.manifest.undoneBy) : all.find((j) => j.stamp === target);
    if (!info) return fail(target === "last" ? "nothing to undo" : `no change ${target} (turno undo --list)`);
    if (info.manifest?.undoneBy && !bool(p, "force"))
      fail(
        `${info.stamp} was already undone by ${info.manifest.undoneBy} (turno undo ${info.manifest.undoneBy} redoes it)`,
      );
    const dry = bool(p, "dry-run");
    const started = Date.now();
    let result;
    try {
      result = undoJournal(info, io.env, { dryRun: dry, force: bool(p, "force") });
    } catch (err) {
      return fail((err as Error).message);
    }
    const st = style(io);
    io.out(`${st.bold(`undo ${info.stamp}`)}  ${info.manifest!.command}${dry ? st.muted("  (dry run)") : ""}`);
    if (bool(p, "verbose")) {
      for (const s of result.steps) {
        const what = s.action === "chmod" ? `mode ${(s.mode ?? 0).toString(8)} again` : VERBS[s.action].one;
        const from = s.from ? st.muted(` from ${tildify(s.from, io.env)}`) : "";
        const text = `${s.action === "skip" ? st.warn(what) : what} ${tildify(s.path, io.env)}${from}${s.reason ? st.muted(`: ${tildifyText(s.reason, io.env)}`) : ""}`;
        io.out(st.note(s.action === "skip" ? "warn" : s.action === "keep" ? "info" : "ok", text));
      }
    } else {
      const rows = summarize(result.steps, io.env).map(({ folder, text, skipped }) => [
        st.icon(skipped ? "warn" : "ok"),
        st.bold(folder),
        text.map((t) => (t.startsWith("skipped") ? st.warn(t) : t)).join(st.muted(", ")),
      ]);
      for (const line of st.table(rows)) io.out(line);
      // What was left alone, and why: never folded into a count.
      for (const s of result.steps.filter((x) => x.action === "skip" || x.action === "keep")) {
        const skip = s.action === "skip";
        io.out(
          st.note(
            skip ? "warn" : "info",
            `${skip ? st.warn("skipped") : "kept"} ${tildify(s.path, io.env)}${s.reason ? st.muted(`: ${tildifyText(s.reason, io.env)}`) : ""}`,
          ),
        );
      }
    }
    const n = result.steps.length;
    io.out("");
    io.out(
      st.wrap(
        "",
        `${dry ? "Would put back" : "Put back"} ${n} ${n === 1 ? "change" : "changes"}${bool(p, "verbose") ? "" : st.muted(" (-v lists each one)")}${dry ? "" : st.muted(` in ${duration(Date.now() - started)}`)}.`,
      ),
    );
    if (result.journal.used) io.out(`${st.muted("Redo with:")} turno undo ${result.journal.stamp}`);
    return result.steps.some((s) => s.action === "skip") ? 1 : 0;
  },
};
