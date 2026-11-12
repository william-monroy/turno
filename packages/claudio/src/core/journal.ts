import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { paths } from "./paths.js";

/**
 * Every command that changes a file the user owns records it in a journal first:
 * backups/<stamp>/journal.json lists each path with a copy of what it held (or that it did
 * not exist), so `claudio undo <stamp>` can put everything back.
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
  const tmp = `${file}.claudio-${process.pid}.tmp`;
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
      if (!st.isFile()) throw new Error(`${target} is not a regular file; claudio only journals files`);
      entry.mode = st.mode & 0o777;
      entry.backup = join("files", `${this.manifest.entries.length}-${basename(target)}`);
      mkdirSync(join(this.dir, "files"), { recursive: true });
      copyFileSync(target, join(this.dir, entry.backup));
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

  private flush(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, MANIFEST), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  /** Save, then write atomically through symlinks so linked profiles keep linking. */
  write(file: string, data: string | Buffer, mode?: number): void {
    if (this.dryRun) return;
    const target = this.save(file);
    let keep = mode;
    if (keep === undefined) {
      try {
        keep = statSync(target).mode & 0o777;
      } catch {
        keep = undefined;
      }
    }
    atomicWrite(target, data, keep);
    this.settle(target);
  }

  remove(file: string): void {
    if (this.dryRun) return;
    const target = this.save(file);
    rmSync(target, { force: true });
    this.settle(target);
  }

  /** The `claudio undo` hint to print after a command that changed something. */
  hint(): string | undefined {
    return this.used ? `undo with: claudio undo ${this.stamp}` : undefined;
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
  const journal = new Journal(env, `undo ${info.stamp}`, dryRun);
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
    writeFileSync(join(info.dir, MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
  }
  return { steps, journal };
}
