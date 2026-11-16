import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../core/paths.js";
import { join } from "node:path";

/**
 * What a server says about itself, enough to answer initialize and the schema-like list
 * methods without it running. resources/list is not cached: resources are data that differ
 * per project and over time, so that method always reaches a running instance.
 */
export interface ServerDescription {
  fingerprint: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  instructions?: string;
  tools?: unknown[];
  prompts?: unknown[];
  resourceTemplates?: unknown[];
  updatedAt: number;
}

export function fingerprint(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export class DescriptionCache {
  private memory = new Map<string, ServerDescription>();

  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9_.@-]/g, "_")}.json`);
  }

  get(key: string, fp: string): ServerDescription | undefined {
    const d = this.peek(key);
    return d && d.fingerprint === fp ? d : undefined;
  }

  /** The stored description whatever its fingerprint (to compare with a fresh one). */
  peek(key: string): ServerDescription | undefined {
    let d = this.memory.get(key);
    if (!d) {
      try {
        d = JSON.parse(readFileSync(this.file(key), "utf8")) as ServerDescription;
        this.memory.set(key, d);
      } catch {
        return undefined;
      }
    }
    return d;
  }

  set(key: string, d: ServerDescription): void {
    this.memory.set(key, d);
    // Under mcpd's data root, which already exists 0700: only the cache folders are created here.
    mkdirSync(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, file);
  }

  delete(key: string): void {
    this.memory.delete(key);
  }

  /** Drop a description from memory and disk, so the next client relearns it. */
  forget(key: string): boolean {
    const had = this.peek(key) !== undefined;
    this.memory.delete(key);
    rmSync(this.file(key), { force: true });
    return had;
  }
}
