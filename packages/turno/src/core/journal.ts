import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { PRIVATE_FILE_MODE, ensurePrivateDir, isPrivatePath, paths } from "./paths.js";

/**
 * Every command that changes a file the user owns records it in a journal first:
 * backups/<stamp>/journal.json lists each path with a copy of what it held (or that it did
 * not exist), so `turno undo <stamp>` can put everything back.
 */
export interface JournalEntry {
  path: string;
  existed: boolean;
  /** Copy of the previous contents, relative to the journal folder. */
  backup?: string;
  mode?: number;
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

/** Backup folders, newest first. */
export function listJournals(env: NodeJS.ProcessEnv = process.env): JournalInfo[] {
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
      try {
        return { stamp: n, dir, manifest: JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as JournalManifest };
      } catch {
        return { stamp: n, dir };
      }
    });
}

export interface UndoStep {
  path: string;
  action: "restore" | "delete" | "skip";
  /** Why a file was skipped: it changed after the journaled command. */
  reason?: string;
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
export function journalTime(info: JournalInfo): number {
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
export function liveEntry(info: JournalInfo): JournalEntry | undefined {
  const m = info.manifest;
  if (!m || m.undoneBy) return undefined;
  return m.entries.find((e) => e.wrote !== undefined && digest(e.path) === e.wrote);
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
export function pruneJournals(env: NodeJS.ProcessEnv = process.env, opts: PruneOptions = {}): PruneResult {
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
