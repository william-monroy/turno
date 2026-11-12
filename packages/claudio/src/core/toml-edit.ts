/**
 * Line-level edits of a TOML file that keep comments, blank lines and the order of everything
 * the edit does not touch. Callers validate the result by parsing it before writing.
 */

export type TomlValue = string | number | boolean | string[];

/** TOML literal of a value (JSON string escapes are valid TOML basic strings). */
export function literal(v: TomlValue): string {
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

const TABLE = /^\s*\[\s*([^[\]#]+?)\s*\]\s*(#.*)?$/;
const ARRAY_TABLE = /^\s*\[\[\s*([^[\]#]+?)\s*\]\]\s*(#.*)?$/;
const isHeader = (l: string) => TABLE.test(l) || ARRAY_TABLE.test(l);
const keyLine = (key: string) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);

/** [start, end) line range of `[table]` (start is the header), or the top level for undefined. */
function tableRange(lines: string[], table: string | undefined): [number, number] | undefined {
  if (table === undefined) {
    const first = lines.findIndex(isHeader);
    return [-1, first < 0 ? lines.length : first];
  }
  const start = lines.findIndex((l) => TABLE.exec(l)?.[1] === table);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !isHeader(lines[end]!)) end++;
  return [start, end];
}

/** Last non-blank line of a range, so new keys go right after the existing ones. */
function insertionPoint(lines: string[], [start, end]: [number, number]): number {
  let at = end;
  while (at > start + 1 && lines[at - 1]!.trim() === "") at--;
  return at;
}

function join(lines: string[]): string {
  const text = lines.join("\n");
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

/** Set `key` in `[table]` (top level when undefined), adding the table at the end if needed. */
export function setValue(text: string, table: string | undefined, key: string, value: TomlValue): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const entry = `${key} = ${literal(value)}`;
  const range = tableRange(lines, table);
  if (!range) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(`[${table}]`, entry);
    return join(lines);
  }
  const re = keyLine(key);
  for (let i = range[0] + 1; i < range[1]; i++) {
    if (re.test(lines[i]!)) {
      lines[i] = entry;
      return join(lines);
    }
  }
  lines.splice(insertionPoint(lines, range), 0, entry);
  return join(lines);
}

/** Remove `key` from `[table]`; the text is unchanged when it is not there. */
export function removeValue(text: string, table: string | undefined, key: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const range = tableRange(lines, table);
  if (!range) return text;
  const re = keyLine(key);
  for (let i = range[0] + 1; i < range[1]; i++) {
    if (re.test(lines[i]!)) {
      lines.splice(i, 1);
      return join(lines);
    }
  }
  return text;
}

/** Add an empty `[table]` when it is missing. */
export function ensureTable(text: string, table: string): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  if (tableRange(lines, table)) return text;
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length) lines.push("");
  lines.push(`[${table}]`);
  return join(lines);
}

/** Remove `[table]` and its keys (comments directly above the header go too). */
export function removeTable(text: string, table: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const range = tableRange(lines, table);
  if (!range) return text;
  let [start, end] = range;
  while (start > 0 && lines[start - 1]!.trim().startsWith("#")) start--;
  while (end < lines.length && lines[end]!.trim() === "" && end + 1 < lines.length && lines[end + 1]!.trim() === "") end++;
  lines.splice(start, end - start);
  return join(lines);
}

/** Simple `key = "string"` pairs of one block, for matching array-of-table entries. */
function blockStrings(lines: string[], start: number, end: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(lines[i]!);
    if (m) out[m[1]!] = JSON.parse(`"${m[2]}"`) as string;
  }
  return out;
}

/** Append a `[[name]]` entry with string keys at the end of the file. */
export function addArrayTable(text: string, name: string, entry: Record<string, TomlValue>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length) lines.push("");
  lines.push(`[[${name}]]`, ...Object.entries(entry).map(([k, v]) => `${k} = ${literal(v)}`));
  return join(lines);
}

/** Remove every `[[name]]` entry whose string keys match `pred`. Returns the text and how many went. */
export function removeArrayTables(text: string, name: string, pred: (e: Record<string, string>) => boolean): { text: string; removed: number } {
  const lines = text.replace(/\n$/, "").split("\n");
  let removed = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ARRAY_TABLE.exec(lines[i]!)?.[1] !== name) continue;
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end++;
    if (!pred(blockStrings(lines, i, end))) continue;
    let start = i;
    while (start > 0 && lines[start - 1]!.trim().startsWith("#")) start--;
    let stop = end;
    while (stop > i + 1 && lines[stop - 1]!.trim() === "") stop--;
    // Drop one blank separator so removals do not leave growing gaps.
    if (start > 0 && lines[start - 1]!.trim() === "") start--;
    lines.splice(start, stop - start);
    removed++;
  }
  return { text: removed ? join(lines) : text, removed };
}
