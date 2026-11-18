import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { PRIVATE_FILE_MODE, ensurePrivateDir, isPrivatePath, paths } from "./paths.js";
import { hasFields, readState } from "./state-file.js";

/**
 * Every command that changes a file the user owns records it in a journal first:
 * backups/<stamp>/journal.json lists each path with a copy of what it held (or that it did
 * not exist), so `turno undo <stamp>` can put everything back.
 *
 * Besides file contents, a journal records the links, folders and moves a command makes,
 * each with its inverse:
 * - "symlink": the command created a link at `path` to `target`; undo removes it.
 * - "unlink": the command removed a link at `path` to `target`; undo creates it again.
 * - "move": the command renamed `path` to `to`; undo renames it back.
 * - "mkdir": the command created the empty folder `path`; undo removes it while it is empty.
 * - "rmdir": the command removed the empty folder `path`; undo creates it again.
 * - "chmod": the command changed the mode of `path` from `mode` to `newMode`; undo sets `mode`
 *   again while the mode is still `newMode`.
 */
type EntryKind = "file" | "symlink" | "unlink" | "move" | "mkdir" | "rmdir" | "chmod";

export interface JournalEntry {
  /** Missing in journals written before link and folder entries existed: a file. */
  kind?: EntryKind;
  path: string;
  existed: boolean;
  /** symlink, unlink: where the link points. */
  target?: string;
  /** move: where `path` went. */
  to?: string;
  /** Copy of the previous contents, relative to the journal folder. */
  backup?: string;
  mode?: number;
  /** chmod: the mode the command set. */
  newMode?: number;
  /** sha256 of what the command left there ("absent" when it deleted the file). */
  wrote?: string;
}

export interface JournalManifest {
  version: 1;
  stamp: string;
  command: string;
  created: string;
  entries: JournalEntry[];
  /** Stamp of the undo that reverted this journal. */
  undoneBy?: string;
}

/** Local "YYYYMMDD-HHMMSS". */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const MANIFEST = "journal.json";

/** Automatic pruning when a new backup is written: older than 30 days, newest 10 always kept. */
export const PRUNE_DEFAULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_DEFAULT_KEEP = 10;

function writeManifest(dir: string, m: JournalManifest): void {
  const file = join(dir, MANIFEST);
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  chmodSync(file, PRIVATE_FILE_MODE);
}

function digest(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "absent";
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A file that does not exist yet: resolve its folder, which may be a symlink.
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** `p` with its folder resolved but not `p` itself: the path of a link, not of what it points to. */
function realParent(p: string): string {
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return p;
  }
}

function lstatOf(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/** Write text atomically, keeping the mode of the file it replaces. */
export function atomicWrite(file: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.turno-${process.pid}.tmp`;
  writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

export class Journal {
  readonly stamp: string;
  readonly dir: string;
  private manifest: JournalManifest;
  private seen = new Set<string>();

  constructor(
    private env: NodeJS.ProcessEnv,
    command: string,
    /** Dry runs record nothing and write nothing. */
    readonly dryRun = false,
    /** Stamps the automatic pruning must not touch (the journal an undo reads from). */
    private protect: string[] = [],
  ) {
    const root = paths(env).backupsDir;
    let s = stamp();
    for (let n = 2; existsSync(join(root, s)); n++) s = `${stamp()}-${n}`;
    this.stamp = s;
    this.dir = join(root, s);
    this.manifest = { version: 1, stamp: s, command, created: new Date().toISOString(), entries: [] };
  }

  get used(): boolean {
    return this.manifest.entries.length > 0;
  }

  /** Record what `file` holds now (once per path). Returns the real path it resolved to. */
  save(file: string): string {
    const target = real(file);
    if (this.dryRun || this.seen.has(target)) return target;
    this.seen.add(target);
    const entry: JournalEntry = { path: target, existed: existsSync(target) };
    if (entry.existed) {
      const st = statSync(target);
      if (!st.isFile()) throw new Error(`${target} is not a regular file; turno only journals files`);
      entry.mode = st.mode & 0o777;
      entry.backup = join("files", `${this.manifest.entries.length}-${basename(target)}`);
      ensurePrivateDir(join(this.dir, "files"), this.env);
      // The copy may hold secrets (a config with a literal token): 0600 inside 0700 folders.
      const copy = join(this.dir, entry.backup);
      copyFileSync(target, copy);
      chmodSync(copy, PRIVATE_FILE_MODE);
    }
    this.manifest.entries.push(entry);
    this.flush();
    return target;
  }

  /** Record what a saved file holds after the command changed it by its own means. */
  settle(file: string): void {
    if (this.dryRun) return;
    const target = real(file);
    const entry = this.manifest.entries.find((e) => e.path === target);
    if (!entry) return;
    entry.wrote = digest(target);
    this.flush();
  }

  private flushed = false;

  private flush(): void {
    ensurePrivateDir(this.dir, this.env);
    writeManifest(this.dir, this.manifest);
    if (!this.flushed) {
      this.flushed = true;
      try {
        pruneJournals(this.env, { exclude: [this.stamp, ...this.protect] });
      } catch {
        /* pruning is housekeeping: never let it break the command that writes */
      }
    }
  }

  /** Save, then write atomically through symlinks so linked profiles keep linking. */
  write(file: string, data: string | Buffer, mode?: number): void {
    if (this.dryRun) return;
    const target = this.save(file);
    // turno's own files (config.toml, mcp.toml, accounts.toml) are private whatever mode they had.
    let keep = mode ?? (isPrivatePath(target, this.env) ? PRIVATE_FILE_MODE : undefined);
    if (keep === undefined) {
      try {
        keep = statSync(target).mode & 0o777;
      } catch {
        keep = undefined;
      }
    }
    if (isPrivatePath(target, this.env)) ensurePrivateDir(dirname(target), this.env);
    atomicWrite(target, data, keep);
    this.settle(target);
  }

  remove(file: string): void {
    if (this.dryRun) return;
    const target = this.save(file);
    rmSync(target, { force: true });
    this.settle(target);
  }

  private record(entry: JournalEntry): void {
    this.manifest.entries.push(entry);
    this.flush();
  }

  /** Create a link at `path` to `target`. */
  symlink(target: string, path: string): void {
    if (this.dryRun) return;
    const at = realParent(path);
    symlinkSync(target, at);
    this.record({ kind: "symlink", path: at, target, existed: false });
  }

  /** Remove the link at `path` (never what it points to). */
  unlink(path: string): void {
    if (this.dryRun) return;
    const at = realParent(path);
    const target = readlinkSync(at);
    rmSync(at);
    this.record({ kind: "unlink", path: at, target, existed: true });
  }

  /** Rename `from` to `to` (a file, a folder or a link). */
  move(from: string, to: string): void {
    if (this.dryRun) return;
    const src = realParent(from);
    const dst = realParent(to);
    renameSync(src, dst);
    this.record({ kind: "move", path: src, to: dst, existed: true });
  }

  /** Create the folder `path` and any missing parents, recording each one it creates. */
  mkdir(path: string, mode?: number): void {
    if (this.dryRun) return;
    const missing: string[] = [];
    for (let p = path; !lstatOf(p); p = dirname(p)) {
      missing.unshift(p);
      if (dirname(p) === p) break;
    }
    for (const p of missing) {
      mkdirSync(p, mode !== undefined ? { mode } : undefined);
      this.record({ kind: "mkdir", path: realParent(p), existed: false, ...(mode !== undefined ? { mode } : {}) });
    }
  }

  /** Remove the empty folder `path`. */
  rmdir(path: string): void {
    if (this.dryRun) return;
    const at = realParent(path);
    const mode = statSync(at).mode & 0o777;
    rmdirSync(at);
    this.record({ kind: "rmdir", path: at, existed: true, mode });
  }

  /** Set the permission bits of `path`, recording the old ones when they change. */
  chmod(path: string, mode: number): void {
    if (this.dryRun) return;
    const at = realParent(path);
    const old = statSync(at).mode & 0o777;
    if (old === mode) return;
    chmodSync(at, mode);
    this.record({ kind: "chmod", path: at, existed: true, mode: old, newMode: mode });
  }

  /** The `turno undo` hint to print after a command that changed something. */
  hint(): string | undefined {
    return this.used ? `undo with: turno undo ${this.stamp}` : undefined;
  }
}

export interface JournalInfo {
  stamp: string;
  dir: string;
  /** Undefined for backup folders written before journals existed. */
  manifest?: JournalManifest;
}

const isManifest = (v: unknown): v is JournalManifest =>
  hasFields(v, { stamp: "string", command: "string", entries: "array" }) &&
  (v.entries as unknown[]).every((e) => hasFields(e, { path: "string" }));

/** Backup folders, newest first. */
export function listJournals(env: NodeJS.ProcessEnv): JournalInfo[] {
  const root = paths(env).backupsDir;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{8}-\d{6}/.test(n))
    .sort()
    .reverse()
    .map((n) => {
      const dir = join(root, n);
      // No manifest, or one that cannot be used: the folder is shown as restore-by-hand.
      const manifest = readState(join(dir, MANIFEST), isManifest, 1);
      return manifest ? { stamp: n, dir, manifest } : { stamp: n, dir };
    });
}

export interface UndoStep {
  path: string;
  /**
   * restore and delete: file contents. unlink and link: a link removed or made again. move: a
   * file or folder moved back to `path` from `from`. rmdir and mkdir: a folder removed or made
   * again. keep: a folder left in place because it holds files made since (not a failure).
   * skip: left alone because it changed since.
   */
  action: "restore" | "delete" | "skip" | "unlink" | "link" | "move" | "rmdir" | "mkdir" | "keep" | "chmod";
  /** move: where the file or folder was. */
  from?: string;
  /** chmod: the mode put back. */
  mode?: number;
  /** Why a step was skipped or kept. */
  reason?: string;
}

function isEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/** Undo one link, move or folder entry through `journal` (which records the inverse). */
function undoTreeEntry(e: JournalEntry, journal: Journal): UndoStep | undefined {
  const st = lstatOf(e.path);
  switch (e.kind) {
    case "symlink": {
      if (!st) return undefined;
      if (!st.isSymbolicLink() || readlinkSync(e.path) !== e.target)
        return { path: e.path, action: "skip", reason: "no longer the link turno made; left as it is" };
      journal.unlink(e.path);
      return { path: e.path, action: "unlink" };
    }
    case "unlink": {
      if (st) return { path: e.path, action: "skip", reason: `something else is there now; it linked to ${e.target}` };
      journal.symlink(e.target!, e.path);
      return { path: e.path, action: "link" };
    }
    case "move": {
      if (st)
        return { path: e.path, action: "skip", reason: `something is there now; the moved copy stays at ${e.to}` };
      if (!lstatOf(e.to!)) return { path: e.path, action: "skip", reason: `${e.to} is gone` };
      journal.move(e.to!, e.path);
      return { path: e.path, action: "move", from: e.to! };
    }
    case "mkdir": {
      if (!st) return undefined;
      if (!st.isDirectory() || !isEmptyDir(e.path))
        return { path: e.path, action: "keep", reason: "not empty (it holds files made since)" };
      journal.rmdir(e.path);
      return { path: e.path, action: "rmdir" };
    }
    case "rmdir": {
      if (st) return undefined;
      journal.mkdir(e.path, e.mode);
      return { path: e.path, action: "mkdir" };
    }
    case "chmod": {
      const step = chmodStep(e, st);
      if (step?.action === "chmod") journal.chmod(e.path, e.mode!);
      return step;
    }
    default:
      return undefined;
  }
}

/** Undoing a mode change: set the old mode again, unless the file is gone or its mode changed since. */
function chmodStep(e: JournalEntry, st: ReturnType<typeof lstatOf>): UndoStep | undefined {
  if (!st || e.mode === undefined) return undefined;
  const now = st.mode & 0o777;
  if (now === e.mode) return undefined;
  if (now !== e.newMode)
    return { path: e.path, action: "skip", reason: `its mode changed since (now ${now.toString(8)}); left as it is` };
  return { path: e.path, action: "chmod", mode: e.mode };
}

/** What undoing a tree entry would do, without doing it (for --dry-run). */
function planTreeEntry(e: JournalEntry): UndoStep | undefined {
  const st = lstatOf(e.path);
  switch (e.kind) {
    case "symlink":
      if (!st) return undefined;
      return st.isSymbolicLink() && readlinkSync(e.path) === e.target
        ? { path: e.path, action: "unlink" }
        : { path: e.path, action: "skip", reason: "no longer the link turno made; left as it is" };
    case "unlink":
      return st
        ? { path: e.path, action: "skip", reason: `something else is there now; it linked to ${e.target}` }
        : { path: e.path, action: "link" };
    case "move":
      if (st)
        return { path: e.path, action: "skip", reason: `something is there now; the moved copy stays at ${e.to}` };
      return lstatOf(e.to!)
        ? { path: e.path, action: "move", from: e.to! }
        : { path: e.path, action: "skip", reason: `${e.to} is gone` };
    case "mkdir":
      if (!st) return undefined;
      // In a dry run nothing inside was removed yet: report the folder as removable.
      return st.isDirectory()
        ? { path: e.path, action: "rmdir" }
        : { path: e.path, action: "keep", reason: "not a folder any more" };
    case "rmdir":
      return st ? undefined : { path: e.path, action: "mkdir" };
    case "chmod":
      return chmodStep(e, st);
    default:
      return undefined;
  }
}

/**
 * Put back every file of a journal. The current contents are journaled first, so an undo can
 * itself be undone.
 */
export function undoJournal(
  info: JournalInfo,
  env: NodeJS.ProcessEnv,
  opts: { dryRun?: boolean; force?: boolean } = {},
): { steps: UndoStep[]; journal: Journal } {
  const dryRun = Boolean(opts.dryRun);
  const m = info.manifest;
  if (!m) throw new Error(`${info.stamp} was written before journals existed; restore it by hand from ${info.dir}`);
  const journal = new Journal(env, `undo ${info.stamp}`, dryRun, [info.stamp]);
  const steps: UndoStep[] = [];
  for (const e of [...m.entries].reverse()) {
    if (e.kind && e.kind !== "file") {
      const step = dryRun ? planTreeEntry(e) : undoTreeEntry(e, journal);
      if (step) steps.push(step);
      continue;
    }
    if (!opts.force && e.wrote && digest(e.path) !== e.wrote) {
      steps.push({ path: e.path, action: "skip", reason: "changed since; --force puts the old copy back anyway" });
      continue;
    }
    if (e.existed && e.backup) {
      steps.push({ path: e.path, action: "restore" });
      journal.write(e.path, readFileSync(join(info.dir, e.backup)), e.mode);
    } else {
      steps.push({ path: e.path, action: "delete" });
      if (existsSync(e.path)) journal.remove(e.path);
    }
  }
  if (!dryRun) {
    m.undoneBy = journal.stamp;
    writeManifest(info.dir, m);
  }
  return { steps, journal };
}

/** When a journal was written: its manifest, else its stamp (local time), else the folder mtime. */
function journalTime(info: JournalInfo): number {
  const created = info.manifest ? Date.parse(info.manifest.created) : Number.NaN;
  if (!Number.isNaN(created)) return created;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(info.stamp);
  if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
  try {
    return statSync(info.dir).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * The first file a journal can still put back cleanly: not undone, and the file holds exactly
 * what the command left there. Its backup is then the only copy of what was there before.
 */
function liveEntry(info: JournalInfo): JournalEntry | undefined {
  const m = info.manifest;
  if (!m || m.undoneBy) return undefined;
  return m.entries.find((e) => (e.kind ?? "file") === "file" && e.wrote !== undefined && digest(e.path) === e.wrote);
}

export interface PruneOptions {
  /** Prune journals older than this (default 30 days). */
  olderThanMs?: number;
  /** Always keep this many newest journals (default 10). */
  keep?: number;
  dryRun?: boolean;
  now?: number;
  /** Stamps never pruned (the journal being written). */
  exclude?: string[];
}

export interface PruneResult {
  pruned: string[];
  /** Old enough to prune but kept: still the live undo point of `path`. */
  kept: { stamp: string; path: string }[];
}

/**
 * Delete old backup folders. The newest `keep` stay, and so does any journal that is still the
 * live undo point of a file (see liveEntry): pruning it would lose the only copy of what that
 * file held before a change the user has not undone.
 */
export function pruneJournals(env: NodeJS.ProcessEnv, opts: PruneOptions = {}): PruneResult {
  const olderThan = opts.olderThanMs ?? PRUNE_DEFAULT_AGE_MS;
  const keep = opts.keep ?? PRUNE_DEFAULT_KEEP;
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.exclude ?? []);
  const result: PruneResult = { pruned: [], kept: [] };
  for (const info of listJournals(env).slice(keep)) {
    if (exclude.has(info.stamp) || now - journalTime(info) < olderThan) continue;
    const live = liveEntry(info);
    if (live) {
      result.kept.push({ stamp: info.stamp, path: live.path });
      continue;
    }
    if (!opts.dryRun) rmSync(info.dir, { recursive: true, force: true });
    result.pruned.push(info.stamp);
  }
  return result;
}

/** Parse an age such as 30d, 12h, 2w, 90m or a bare number of days. */
export function parseAge(text: string): number {
  const m = /^(\d+)\s*([smhdw]?)$/.exec(text.trim());
  if (!m) throw new Error(`invalid age ${JSON.stringify(text)}: use a number with s, m, h, d or w (30d)`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, "": 86400 }[m[2] as "s" | "m" | "h" | "d" | "w" | ""];
  return Number(m[1]) * unit * 1000;
}
