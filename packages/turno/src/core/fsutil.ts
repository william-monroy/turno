import { readFileSync, realpathSync } from "node:fs";
import { CliError } from "../cli/io.js";

/** Small file and process helpers shared across modules. Keep this file free of heavy imports. */

/** The real path of `p`, or `p` itself when it cannot be resolved (it does not exist, no access). */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The parsed JSON of a file, or undefined when it is missing, unreadable or not JSON. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON object: not null, not an array. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The object in a JSON config another program writes (Claude Code's .claude.json and
 * settings.json, Cursor's mcp.json): valid JSON of any other shape is an error naming the file,
 * not a TypeError later.
 */
export function parseJsonObject(text: string, file: string): Record<string, unknown> {
  const v = JSON.parse(text) as unknown;
  if (!isObject(v)) throw new CliError(`${file} does not hold a JSON object; fix or remove it`);
  return v;
}

/** Whether a process is alive; shared with turno-browser. */
export { pidAlive } from "turno-core/process";
