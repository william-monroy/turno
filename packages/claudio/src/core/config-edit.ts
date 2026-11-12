import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../cli/io.js";
import { parseConfig } from "./config.js";
import type { Journal } from "./journal.js";
import { paths, tildify } from "./paths.js";

export class MigrationPending extends UsageError {
  constructor(env: NodeJS.ProcessEnv) {
    super(`${tildify(paths(env).legacyConfig, env)} still holds the bash claudio config; run claudio migrate first`);
  }
}

/** True while the bash config is there and config.toml is not: a new config.toml would block migrate. */
export function migrationPending(env: NodeJS.ProcessEnv): boolean {
  const p = paths(env);
  return !existsSync(p.configFile) && ["proyectos", "navegador"].some((f) => existsSync(join(p.legacyConfig, f)));
}

export function readConfigText(env: NodeJS.ProcessEnv): string {
  try {
    return readFileSync(paths(env).configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Apply a text edit to config.toml: comments and layout stay, the result must parse, and the
 * write goes through the journal. Returns whether anything changed.
 */
export function editConfig(env: NodeJS.ProcessEnv, journal: Journal, edit: (text: string) => string): { changed: boolean; text: string } {
  if (migrationPending(env)) throw new MigrationPending(env);
  const file = paths(env).configFile;
  const before = readConfigText(env);
  const after = edit(before);
  if (after === before) return { changed: false, text: after };
  parseConfig(after, file, env);
  journal.write(file, after);
  return { changed: true, text: after };
}
