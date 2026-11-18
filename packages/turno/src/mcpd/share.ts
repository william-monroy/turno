/**
 * `turno mcp export` and `turno mcp import <file>`: mcp.toml without secret values, and merging
 * such a file (or another agent's MCP config) into mcp.toml. An exported file names each secret
 * by its `keychain:` or `env:` reference; literal secrets become `keychain:turno/<server>/<key>`
 * references that the importing machine fills with `turno secret set`.
 */
import { parse, stringify } from "smol-toml";
import { parseManifest } from "../core/manifest.js";
import { argSecrets, isSecretValue, serviceKey, urlSecrets } from "./importer.js";

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

/** What an export holds besides the servers: the secrets and variables the importer needs. */
export interface ExportResult {
  text: string;
  servers: string[];
  /** Keychain services the servers reference, existing references and moved literals. */
  keychain: string[];
  /** Variables mcpd reads from its environment (`env:NAME`). */
  envVars: string[];
  /** `server.KEY` literals replaced by a keychain reference. */
  moved: string[];
  /** `server.args` / `server.url` whose secret was replaced by `<secret>` (no reference fits there). */
  redacted: string[];
}

/**
 * mcp.toml text without secret values. With `profile`, only the servers that profile gets and
 * only its own variant. Comments are not kept (the file is generated).
 */
export function exportManifest(text: string, opts: { profile?: string; command?: string } = {}): ExportResult {
  const manifest = parseManifest(text); // refuse to export a file mcpd would refuse
  const raw = parse(text) as Table;
  const table = isTable(raw.server) ? raw.server : {};
  const keychain = new Set<string>();
  const envVars = new Set<string>();
  const moved: string[] = [];
  const redacted: string[] = [];
  const out: Record<string, Table> = {};

  const refOf = (v: string) => {
    if (v.startsWith("keychain:")) keychain.add(v.slice("keychain:".length));
    else if (v.startsWith("env:")) envVars.add(v.slice(4).replace(/:-.*$/, ""));
  };
  /** env and headers: references stay, literal secrets become references. */
  const values = (server: string, scope: string, map: unknown): Table | undefined => {
    if (!isTable(map)) return undefined;
    const next: Table = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== "string") {
        next[k] = v;
        continue;
      }
      if (v.startsWith("keychain:") || v.startsWith("env:")) {
        refOf(v);
        next[k] = v;
      } else if (!v.includes("${") && isSecretValue(k, v)) {
        const service = `turno/${scope}/${serviceKey(k)}`;
        keychain.add(service);
        moved.push(`${server}.${k}`);
        next[k] = `keychain:${service}`;
      } else next[k] = v;
    }
    return next;
  };
  const scrub = (server: string, scope: string, t: Table): Table => {
    const next: Table = { ...t };
    for (const key of ["env", "headers"]) {
      const v = values(server, scope, t[key]);
      if (v) next[key] = v;
    }
    if (Array.isArray(t.args)) {
      const args = t.args.map(String);
      const found = argSecrets(args);
      if (found.length) {
        next.args = args.map((a) => found.reduce((s, f) => s.split(f).join("<secret>"), a));
        redacted.push(`${server}.args`);
      }
    }
    if (typeof t.url === "string") {
      const found = urlSecrets(t.url);
      if (found.length) {
        let url = t.url;
        for (const f of found) url = url.split(f).join("<secret>").split(encodeURIComponent(f)).join("<secret>");
        next.url = url;
        redacted.push(`${server}.url`);
      }
    }
    if (isTable(t.oauth) && typeof t.oauth.client_secret === "string") refOf(t.oauth.client_secret);
    return next;
  };

  for (const [name, value] of Object.entries(table)) {
    if (!isTable(value)) continue;
    const def = manifest.servers[name]!;
    if (opts.profile && !def.profiles.includes("*") && !def.profiles.includes(opts.profile)) continue;
    const server = scrub(name, name, value);
    if (isTable(value.variant)) {
      const variants: Table = {};
      for (const [prof, v] of Object.entries(value.variant)) {
        if (opts.profile && prof !== opts.profile) continue;
        if (isTable(v)) variants[prof] = scrub(`${name}.variant.${prof}`, `${name}/${prof}`, v);
      }
      if (Object.keys(variants).length) server.variant = variants;
      else delete server.variant;
    }
    out[name] = server;
  }

  const names = Object.keys(out);
  const head = [
    `# turno MCP servers, from \`${opts.command ?? "turno mcp export"}\`. No secret values: each secret is`,
    "# a keychain: or env: reference. Import it with: turno mcp import <this file> --write",
  ];
  if (keychain.size) {
    head.push("#", "# Store these secrets on the machine that imports it (the value on stdin):");
    for (const s of [...keychain].sort()) head.push(`#   turno secret set ${s}`);
  }
  if (envVars.size) head.push("#", `# Variables mcpd reads from its environment: ${[...envVars].sort().join(", ")}`);
  if (redacted.length) head.push("#", `# Secrets replaced by <secret> (args and URLs cannot hold a reference): ${redacted.join(", ")}`);
  const body = names.length ? `${stringify({ server: out })}\n` : "";
  const result = `${head.join("\n")}\n\n${body}`;
  parseManifest(result, "export"); // never print something import would refuse
  return { text: result, servers: names, keychain: [...keychain].sort(), envVars: [...envVars].sort(), moved, redacted };
}

/** The parts of a TOML table header: `server."a.b".env` is server, a.b, env. */
function headerPath(inner: string): string[] {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\.|$)/y;
  re.lastIndex = 0;
  while (re.lastIndex < inner.length) {
    const m = re.exec(inner);
    if (!m) break;
    parts.push(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : (m[2] ?? m[3]!));
  }
  return parts;
}

const HEADER = /^\s*\[\[?\s*([^[\]#]+?)\s*\]\]?\s*(#.*)?$/;

/**
 * Remove `[server.<name>]` and its sub-tables (`[server.<name>.env]`, variants, ...) from
 * mcp.toml text, keeping the rest and its comments. Undefined when the server is defined some
 * other way (an inline table, dotted keys under `[server]`) and the text has to be edited by hand.
 */
export function removeServer(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const keep: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const h = HEADER.exec(line);
    if (h) {
      const path = headerPath(h[1]!);
      dropping = path[0] === "server" && path[1] === name;
    }
    if (!dropping) keep.push(line);
  }
  const next = keep.join("\n").replace(/\n{3,}/g, "\n\n");
  try {
    return parseManifest(next).servers[name] ? undefined : next;
  } catch {
    return undefined;
  }
}

export interface MergeResult {
  text: string;
  added: string[];
  replaced: string[];
  /** Servers already in mcp.toml, left as they are (without --force). */
  kept: string[];
}

/**
 * Merge server tables into mcp.toml text: new names are appended, names already there are kept
 * unless `force`, which replaces their tables. Throws when a server cannot be replaced in place.
 */
export function mergeServers(existing: string, incoming: Record<string, Table>, force: boolean): MergeResult {
  const current = existing.trim() ? parseManifest(existing).servers : {};
  let text = existing;
  const added: string[] = [];
  const replaced: string[] = [];
  const kept: string[] = [];
  const append: Record<string, Table> = {};
  for (const [name, table] of Object.entries(incoming)) {
    if (current[name]) {
      if (!force) {
        kept.push(name);
        continue;
      }
      const next = removeServer(text, name);
      if (next === undefined) throw new Error(`cannot replace server ${name} in mcp.toml (it is not a [server.${name}] table); edit it by hand`);
      text = next;
      replaced.push(name);
    } else added.push(name);
    append[name] = table;
  }
  if (Object.keys(append).length) {
    const trimmed = text.replace(/\s+$/, "");
    text = `${trimmed}${trimmed ? "\n\n" : ""}${stringify({ server: append })}\n`;
  }
  parseManifest(text); // never write something mcpd cannot read back
  return { text, added, replaced, kept };
}

/** The server tables of a file in mcp.toml's format (what `turno mcp export` prints). */
export function manifestServers(text: string, file: string): Record<string, Table> {
  parseManifest(text, file);
  const raw = parse(text) as Table;
  const out: Record<string, Table> = {};
  if (isTable(raw.server)) for (const [n, v] of Object.entries(raw.server)) if (isTable(v)) out[n] = v;
  return out;
}
