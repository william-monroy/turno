import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a server says about itself, enough to answer initialize and the list methods without it running. */
export interface ServerDescription {
  fingerprint: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  instructions?: string;
  tools?: unknown[];
  prompts?: unknown[];
  resources?: unknown[];
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
    let d = this.memory.get(key);
    if (!d) {
      try {
        d = JSON.parse(readFileSync(this.file(key), "utf8")) as ServerDescription;
        this.memory.set(key, d);
      } catch {
        return undefined;
      }
    }
    return d.fingerprint === fp ? d : undefined;
  }

  set(key: string, d: ServerDescription): void {
    this.memory.set(key, d);
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2));
    renameSync(tmp, file);
  }

  delete(key: string): void {
    this.memory.delete(key);
  }
}
