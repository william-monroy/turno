import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentId, adapter, mcpFileFor } from "../../agents/index.js";
import { gatewaySnippet, isSnippetAgent, SNIPPET_AGENTS } from "../../agents/snippets.js";
import { type Config, loadConfig } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { type StdioServer, loadManifest, parseManifest, servesProfile } from "../../core/manifest.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { agentOf, listProfiles } from "../../core/profiles.js";
import { liveSessions } from "../../core/sessions.js";
import { DRY_RUN, FORCE, type FlagSpec, JSON_FLAG, bool, parseFlags, printJson, str } from "../args.js";
import { type Sub, group } from "../group.js";
import { type Io, fail, paint } from "../io.js";

const run = promisify(execFile);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const flagsOf = (spec: FlagSpec) => Object.keys(spec).map((k) => `--${k}`);

/**
 * One authenticated request to the running mcpd, with the port and token `mcp sync` writes.
 * "down" when there is no token or nothing answers. Kept small so the endpoints can change.
 */
export async function mcpdRequest(
  env: NodeJS.ProcessEnv,
  method: "GET" | "POST",
  path: string,
  timeoutMs = 2000,
): Promise<{ status: number; body: unknown } | "down"> {
  const { mcpdPort, readToken } = await import("../../mcpd/daemon.js");
  const token = readToken(env);
  if (!token) return "down";
  try {
    const res = await fetch(`http://127.0.0.1:${mcpdPort(env)}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } catch {
    return "down";
  }
}

async function mcpdAnswers(env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await mcpdRequest(env, "GET", "/status");
  return r !== "down" && r.status === 200;
}

// list ---------------------------------------------------------------------------------------

const LIST_FLAGS: FlagSpec = { ...JSON_FLAG };

/** Rows padded to the widest cell of each column (the last column is not padded). */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

async function list(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, LIST_FLAGS, 0);
  const m = loadManifest(io.env);
  const names = Object.keys(m.servers).sort();
  if (bool(flags, "json")) {
    printJson(
      io.out,
      names.map((n) => {
        const s = m.servers[n]!;
        return s.kind === "remote"
          ? { name: n, kind: "remote", url: s.url, proxy: Boolean(s.proxy), profiles: s.profiles }
          : { name: n, kind: "stdio", command: s.builtin ? `builtin ${s.builtin}` : s.command, scope: s.scope, exclusive: Boolean(s.exclusive), idleSeconds: s.idle, profiles: s.profiles, package: s.package ?? null, variants: Object.keys(s.variants) };
      }),
    );
    return 0;
  }
  if (!names.length) {
    io.out(`no servers in ${tildify(paths(io.env).mcpFile, io.env)} yet; draft it from your agent configs with: turno mcp import`);
    return 0;
  }
  const rows = [["NAME", "RUNS", "HOW", "IDLE", "PROFILES", "NOTES"]];
  for (const name of names) {
    const s = m.servers[name]!;
    const where = s.profiles.includes("*") ? "all" : s.profiles.join(", ");
    if (s.kind === "remote") {
      rows.push([name, s.url, s.proxy ? "remote via mcpd" : "remote direct", s.proxy ? `${Math.round(s.idle / 60)}m` : "-", where, ""]);
      continue;
    }
    const variants = Object.keys(s.variants);
    const installed = s.package && existsSync(join(paths(io.env).serversDir, s.name, "node_modules"));
    const notes = [variants.length ? `variants: ${variants.join(", ")}` : "", s.package ? `package ${s.package}${installed ? "" : " (not installed)"}` : ""].filter(Boolean);
    rows.push([name, s.builtin ? `builtin ${s.builtin}` : s.command, `${s.scope}${s.exclusive ? " exclusive" : ""}`, `${Math.round(s.idle / 60)}m`, where, notes.join("; ")]);
  }
  const lines = table(rows);
  io.out(paint(io, lines[0]!, "1"));
  for (const l of lines.slice(1)) io.out(l);
  return 0;
}

// sync ---------------------------------------------------------------------------------------

interface Target {
  profile: string;
  file: string;
  agent: AgentId;
  /** The hub config used by plain `claude` (~/.claude.json). */
  plain?: boolean;
}

function targets(io: Io, config: Config, only: string[]): Target[] {
  const p = paths(io.env);
  const out: Target[] = [];
  let cursorDone = false;
  for (const name of listProfiles(config, io.env)) {
    if (only.length && !only.includes(name)) continue;
    const agent = agentOf(name, config);
    if (adapter(agent).sharedMcpFile) {
      // One file for every Cursor profile: entries route by the launcher's environment.
      if (cursorDone) continue;
      cursorDone = true;
      out.push({ profile: "", file: mcpFileFor(name, agent, io.env), agent });
      continue;
    }
    out.push({ profile: name, file: agent === "claude" ? join(profileDir(name, io.env), ".claude.json") : mcpFileFor(name, agent, io.env), agent });
  }
  // The hub config belongs to the system profile (plain `claude`).
  const hubProfile = config.system ?? "default";
  if ((!only.length || only.includes(hubProfile) || only.includes("hub")) && existsSync(p.hubConfig)) {
    out.push({ profile: hubProfile, file: p.hubConfig, agent: "claude", plain: true });
  }
  return out;
}

/**
 * Who has a live session: profiles from launcher run records (or the system profile), and
 * whether plain `claude` has one. Reads only the sandbox-able paths of `env`.
 */
function busyState(env: NodeJS.ProcessEnv, config: Config): { profiles: Set<string>; plain: boolean } {
  const sessions = liveSessions(env, config);
  return {
    profiles: new Set(sessions.flatMap((s) => (s.profile ? [s.profile] : []))),
    plain: sessions.some((s) => s.source === "system"),
  };
}

const SYNC_FLAGS: FlagSpec = { ...DRY_RUN, ...FORCE };

async function sync(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, SYNC_FLAGS);
  const dryRun = bool(flags, "dry-run");
  const force = bool(flags, "force");
  const only = flags.positionals;
  const config = loadConfig(io.env);
  const known = new Set([...listProfiles(config, io.env), config.system ?? "default", "hub"]);
  for (const name of only) if (!known.has(name)) fail(`no profile '${name}' (turno profile list shows them)`);
  const { profileServers, readManaged, syncCodexToml, syncConfigFile, syncJsonServers, writeManaged } = await import("../../mcpd/sync.js");
  const { ensureToken, mcpdPort, readToken } = await import("../../mcpd/daemon.js");
  const manifest = loadManifest(io.env);
  // A dry run never creates the token; without one, entries show a placeholder.
  const token = dryRun ? (readToken(io.env) ?? "<token>") : ensureToken(io.env);
  const port = mcpdPort(io.env);
  const p = paths(io.env);
  const managed = readManaged(p.mcpdManaged);
  const managedBefore = JSON.stringify(managed);
  const busy = busyState(io.env, config);
  let skipped = 0;
  let changed = 0;
  let gatewayTargets = 0;
  const journal = new Journal(io.env, `mcp sync ${args.join(" ")}`.trim(), dryRun);
  for (const t of targets(io, config, only)) {
    const where = tildify(t.file, io.env);
    const label = t.plain
      ? `plain claude${config.system ? `, profile ${config.system}` : ""} (${where})`
      : `${t.profile || `${adapter(t.agent).label} profiles`} (${where})`;
    const isBusy = t.plain ? busy.plain || busy.profiles.has(t.profile) : Boolean(t.profile) && busy.profiles.has(t.profile);
    if (isBusy && !force) {
      io.out(`${paint(io, dryRun ? "would skip" : "skip", "33")} ${label}: has open sessions; close them or use --force`);
      skipped++;
      continue;
    }
    const wanted = profileServers(manifest, t.profile, port, token, t.agent);
    if (Object.values(manifest.servers).some((s) => servesProfile(s, t.profile) && !(s.kind === "remote" && !s.proxy))) gatewayTargets++;
    const prev = managed[t.file] ?? [];
    const apply = (dry: boolean) =>
      t.agent === "codex"
        ? syncCodexToml(t.file, wanted, prev, { dryRun: dry })
        : t.agent === "claude"
          ? syncConfigFile(t.file, wanted, prev, { dryRun: dry })
          : syncJsonServers(t.file, "mcpServers", wanted, prev, { dryRun: dry });
    // Plan first, so a file that would not change is neither backed up nor rewritten.
    let res = apply(true);
    if (res.changed && !dryRun) {
      const before = journal.save(t.file);
      res = apply(false);
      journal.settle(before);
    }
    if (res.changed) changed++;
    if (!dryRun) managed[t.file] = Object.keys(wanted);
    const verbs = dryRun ? ["would add", "would update", "would remove", "would leave alone"] : ["added", "updated", "removed", "left alone"];
    const parts = [res.added, res.updated, res.removed, res.foreign].map((names, i) => (names.length ? `${verbs[i]} ${names.join(", ")}` : "")).filter(Boolean);
    const tag = dryRun ? "plan" : res.changed ? "sync" : "same";
    const detail = parts.length ? `: ${parts.join("; ")}` : dryRun && !res.changed ? ": no changes" : "";
    io.out(`${paint(io, tag, res.changed ? "32" : "2")} ${label}${detail}`);
    if (t.agent === "cursor" && res.added.length && !dryRun) {
      io.out(`  Cursor asks to approve new servers once: cursor-agent mcp enable <name> (${res.added.join(", ")})`);
    }
  }
  if (!dryRun && JSON.stringify(managed) !== managedBefore) writeManaged(p.mcpdManaged, managed);
  if (!dryRun && changed) io.out("New sessions pick this up; open sessions keep their old servers until restarted.");
  const hint = changed && !dryRun ? journal.hint() : undefined;
  if (hint) io.out(hint);
  if (gatewayTargets && !(await mcpdAnswers(io.env))) {
    io.err(`${paint(io, "warning", "33")}: mcpd is not running, so these profiles have no local MCP servers until you run: turno mcp daemon start`);
  }
  return skipped ? 1 : 0;
}

// config -------------------------------------------------------------------------------------

const CONFIG_FLAGS: FlagSpec = { agent: { type: "string" }, profile: { type: "string" }, ...JSON_FLAG };

async function config(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, CONFIG_FLAGS, 0);
  const agent = str(p, "agent");
  if (!agent || !isSnippetAgent(agent)) {
    return fail(`usage: turno mcp config --agent <${SNIPPET_AGENTS.join("|")}> [--profile <p>]\n(Claude Code, Codex, Copilot and Cursor profiles get their entries from turno mcp sync)`);
  }
  const cfg = loadConfig(io.env);
  const profile = str(p, "profile") ?? cfg.default ?? "default";
  const manifest = loadManifest(io.env);
  const servers = Object.entries(manifest.servers)
    .filter(([, def]) => servesProfile(def, profile) && !(def.kind === "remote" && !def.proxy))
    .map(([name]) => name);
  if (!servers.length) return fail(`no gateway servers for profile ${profile} in mcp.toml`);
  const { mcpdPort } = await import("../../mcpd/daemon.js");
  const s = gatewaySnippet(agent, servers, mcpdPort(io.env), profile);
  if (bool(p, "json")) {
    printJson(io.out, { agent, profile, servers, file: s.file, notes: s.notes, text: s.text });
    return 0;
  }
  io.out(`# ${s.file}`);
  for (const n of s.notes) io.out(`# ${n}`);
  io.out(s.text.trimEnd());
  return 0;
}

// import -------------------------------------------------------------------------------------

/** The bin npx would run: the only one, else the one named after the package. */
export function pickBin(pkg: string, bin: string | Record<string, string>): string | undefined {
  const base = pkg.replace(/^@[^/]+\//, "");
  if (typeof bin === "string") return base;
  const names = Object.keys(bin);
  if (names.length === 1) return names[0];
  return names.find((n) => n === base) ?? names.find((n) => n.includes("mcp"));
}

function npm(io: Io, args: string[], timeout: number): Promise<{ stdout: string }> {
  return run("npm", args, { timeout, env: io.env });
}

async function binOf(io: Io, pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await npm(io, ["view", pkg, "bin", "--json"], 20_000);
    const bin = JSON.parse(stdout || "null") as string | Record<string, string> | null;
    if (!bin) return undefined;
    return pickBin(pkg, bin);
  } catch {
    return undefined;
  }
}

const IMPORT_FLAGS: FlagSpec = { write: { type: "boolean" }, "move-secrets": { type: "boolean" }, ...FORCE, ...DRY_RUN };

async function importCmd(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, IMPORT_FLAGS, 0);
  const write = bool(flags, "write");
  const moveSecrets = bool(flags, "move-secrets");
  if (write && bool(flags, "dry-run")) fail("--dry-run and --write do not go together (without --write it is a preview)");
  const { collectSources, foundSummary, importServers, mergeSources } = await import("../../mcpd/importer.js");
  const p = paths(io.env);
  const { sources, problems } = collectSources(io.env, process.cwd());
  for (const pr of problems) io.err(`${paint(io, "warning", "33")}: ${pr}`);
  const merged = mergeSources(sources);
  const names = Object.keys(merged.servers);
  if (!names.length) {
    io.out("No MCP servers found in Claude Code (~/.claude.json, .mcp.json), Codex, Cursor or Copilot CLI configs.");
    io.out("Nothing written. Add servers to mcp.toml by hand: see docs/mcp.md in the turno repository.");
    return write ? 1 : 0;
  }
  io.err(foundSummary(names, merged.from));
  const report = await importServers(merged.servers, { moveSecrets, binOf: (pkg) => binOf(io, pkg) });
  parseManifest(report.toml); // never write something we cannot read back
  for (const n of [...merged.notes, ...report.notes]) io.err(`  ${n}`);
  if (report.literalSecrets.length) {
    io.err(`  ${paint(io, "warning", "33")}: literal secrets kept (${report.literalSecrets.join(", ")}); add --move-secrets to store them in the Keychain`);
  }
  const exists = existsSync(p.mcpFile);
  if (!write) {
    for (const s of report.secrets) io.err(`  would move ${s.where} to keychain:${s.service}`);
    io.out(report.preview.trimEnd());
    const again = ["turno mcp import --write", moveSecrets || report.literalSecrets.length ? "--move-secrets" : "", exists ? "--force" : ""].filter(Boolean).join(" ");
    io.err(`Nothing written. Write it with: ${again}`);
    return 0;
  }
  if (exists && !bool(flags, "force")) return fail(`${tildify(p.mcpFile, io.env)} exists; use --force (it is backed up)`);
  const { storeKeychainSecret } = await import("../../core/secrets.js");
  for (const s of report.secrets) {
    if (s.value.includes("${")) continue; // never store a placeholder
    await storeKeychainSecret(s.service, s.value);
    io.err(`  moved ${s.where} to keychain:${s.service}`);
  }
  const journal = new Journal(io.env, "mcp import --write");
  journal.write(p.mcpFile, report.toml, 0o600);
  io.out(`wrote ${tildify(p.mcpFile, io.env)} with ${plural(names.length, "server")}`);
  io.out(journal.hint()!);
  return 0;
}

// install ------------------------------------------------------------------------------------

/** `@scope/pkg@^1.2` -> name `@scope/pkg`, range `^1.2`; a bare name has an empty range. */
export function splitSpec(spec: string): { name: string; range: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), range: spec.slice(at + 1) } : { name: spec, range: "" };
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Replace the `package` value of `[server.<name>]` in mcp.toml text, keeping everything else.
 * Undefined when the line is not where we expect it (inline tables and the like).
 */
export function pinPackage(text: string, server: string, spec: string): string | undefined {
  const lines = text.split("\n");
  const header = /^\s*\[\s*server\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+?)\s*\]\s*(#.*)?$/;
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const h = header.exec(lines[i]!);
    if (h) {
      const name = h[1]!.startsWith('"') ? (JSON.parse(h[1]!) as string) : h[1]!;
      inside = name === server;
      continue;
    }
    if (/^\s*\[/.test(lines[i]!)) {
      inside = false;
      continue;
    }
    if (!inside) continue;
    const m = /^(\s*package\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/.exec(lines[i]!);
    if (!m) continue;
    lines[i] = `${m[1]}${JSON.stringify(spec)}${m[3]}`;
    const next = lines.join("\n");
    try {
      const s = parseManifest(next).servers[server];
      return s?.kind === "stdio" && s.package === spec ? next : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function exactVersion(io: Io, spec: string): Promise<string> {
  const { name, range } = splitSpec(spec);
  if (EXACT.test(range)) return range;
  const { stdout } = await npm(io, ["view", `${name}@${range || "latest"}`, "version", "--json"], 30_000);
  const v = JSON.parse(stdout || "null") as string | string[] | null;
  const version = Array.isArray(v) ? v[v.length - 1] : v;
  if (!version || !EXACT.test(version)) throw new Error(`npm found no version of ${spec}`);
  return version;
}

const INSTALL_FLAGS: FlagSpec = { ...DRY_RUN, "allow-scripts": { type: "boolean" } };

async function install(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, INSTALL_FLAGS);
  const dryRun = bool(flags, "dry-run");
  const allowScripts = bool(flags, "allow-scripts");
  const only = flags.positionals;
  const m = loadManifest(io.env);
  for (const n of only) if (!m.servers[n]) fail(`unknown server '${n}' (turno mcp list shows them)`);
  const p = paths(io.env);
  const wanted = Object.values(m.servers).filter(
    (s): s is StdioServer => s.kind === "stdio" && Boolean(s.package) && (!only.length || only.includes(s.name)),
  );
  if (!wanted.length) {
    io.out("nothing to install (no server declares a package)");
    return 0;
  }
  let text = existsSync(p.mcpFile) ? readFileSync(p.mcpFile, "utf8") : "";
  const pins: string[] = [];
  let failed = 0;
  for (const s of wanted) {
    const { name } = splitSpec(s.package!);
    let version: string;
    try {
      version = await exactVersion(io, s.package!);
    } catch (err) {
      failed++;
      io.err(`${s.name}: cannot resolve ${s.package}: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    const pinned = `${name}@${version}`;
    const dir = join(p.serversDir, s.name);
    const lock = join(dir, "package-lock.json");
    let deps: Record<string, string> = {};
    try {
      deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
    } catch {
      /* first install */
    }
    // Same version and a lockfile: reinstall exactly what was installed before.
    const fromLock = existsSync(lock) && deps[name] === version;
    if (dryRun) {
      io.out(`would install ${pinned} for ${s.name}${fromLock ? " from its lockfile" : ""}${allowScripts ? "" : " without install scripts"}`);
      if (pinned !== s.package) io.out(`would pin package = "${pinned}" in ${tildify(p.mcpFile, io.env)}`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), `{ "private": true }\n`);
    const common = ["--no-audit", "--no-fund", "--prefix", dir, ...(allowScripts ? [] : ["--ignore-scripts"])];
    const npmArgs = fromLock ? ["ci", ...common] : ["install", "--save-exact", "--package-lock=true", ...common, pinned];
    io.out(`installing ${pinned} for ${s.name}${fromLock ? " from its lockfile" : ""}...`);
    try {
      await npm(io, npmArgs, 300_000);
      const bin = join(dir, "node_modules", ".bin", s.command);
      io.out(existsSync(bin) ? `  ok: ${tildify(bin, io.env)}` : `  ${paint(io, "warning", "33")}: installed but no bin named ${s.command}`);
    } catch (err) {
      failed++;
      io.err(`  failed: ${(err as Error).message.split("\n")[0]}`);
      if (!allowScripts) io.err("  if the package needs its install scripts, retry with --allow-scripts");
      continue;
    }
    if (pinned === s.package) continue;
    const next = pinPackage(text, s.name, pinned);
    if (next === undefined) {
      io.err(`  ${paint(io, "warning", "33")}: could not pin ${s.name} in mcp.toml; set package = "${pinned}" by hand`);
      continue;
    }
    text = next;
    pins.push(`${s.name} to ${pinned}`);
  }
  if (pins.length) {
    const journal = new Journal(io.env, "mcp install");
    journal.write(p.mcpFile, text);
    io.out(`pinned ${pins.join(", ")} in ${tildify(p.mcpFile, io.env)}`);
    io.out(journal.hint()!);
  }
  return failed ? 1 : 0;
}

// refresh ------------------------------------------------------------------------------------

const REFRESH_FLAGS: FlagSpec = { ...DRY_RUN };

/** Ask mcpd to forget and relearn one server's descriptions (POST /refresh/<server>). */
async function refreshInDaemon(env: NodeJS.ProcessEnv, server: string): Promise<"ok" | "unsupported" | "down" | string> {
  const r = await mcpdRequest(env, "POST", `/refresh/${encodeURIComponent(server)}`, 15_000);
  if (r === "down") return "down";
  if (r.status >= 200 && r.status < 300) return "ok";
  if (r.status === 404) return "unsupported";
  const msg = typeof r.body === "object" && r.body && "error" in r.body ? String((r.body as { error: unknown }).error) : `HTTP ${r.status}`;
  return msg;
}

async function refresh(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, REFRESH_FLAGS);
  const dryRun = bool(flags, "dry-run");
  const only = flags.positionals;
  const dir = paths(io.env).mcpdCacheDir;
  const cached = existsSync(dir) ? readdirSync(dir) : [];
  const manifest = loadManifest(io.env);
  for (const n of only) {
    if (!manifest.servers[n] && !cached.some((f) => f.startsWith(`${n}@`))) fail(`unknown server '${n}' (turno mcp list shows them)`);
  }
  const files = cached.filter((f) => !only.length || only.some((a) => f.startsWith(`${a}@`)));
  const servers = only.length ? only : Object.keys(manifest.servers).sort();
  if (dryRun) {
    io.out(`would forget ${plural(files.length, "cached description")}${servers.length ? ` and ask mcpd to relearn ${servers.join(", ")}` : ""}`);
    return 0;
  }
  for (const f of files) rmSync(join(dir, f), { force: true });
  io.out(`forgot ${plural(files.length, "cached description")}`);
  if (!servers.length) return 0;
  let fallback = false;
  let failed = 0;
  const done: string[] = [];
  for (const s of servers) {
    const r = await refreshInDaemon(io.env, s);
    if (r === "down") {
      io.out("mcpd is not running; it learns them again when it starts");
      return 0;
    }
    if (r === "unsupported") {
      fallback = true;
      break;
    }
    if (r === "ok") done.push(s);
    else {
      failed++;
      io.err(`${s}: mcpd could not refresh it: ${r}`);
    }
  }
  if (fallback) io.out("restart mcpd so it relearns them: turno mcp daemon restart");
  else if (done.length) io.out(`mcpd refreshed ${done.join(", ")}`);
  return failed ? 1 : 0;
}

// doctor -------------------------------------------------------------------------------------

export interface Bypass {
  /** Plugin stdio servers that start in every session. */
  plugins: { plugin: string; name: string; command: string; toolPrefix: string }[];
  /** Stdio servers configured directly in the hub config, and whether mcp.toml has them. */
  direct: { name: string; inManifest: boolean }[];
}

/** Local servers that do not go through mcpd. */
export async function bypassingServers(env: NodeJS.ProcessEnv): Promise<Bypass> {
  const { pluginServers } = await import("../../mcpd/importer.js");
  const p = paths(env);
  const manifest = loadManifest(env);
  const plugins = pluginServers(p.hub)
    .filter((s) => s.transport === "stdio")
    .map((s) => ({ plugin: s.plugin, name: s.name, command: String(s.command), toolPrefix: s.toolPrefix }));
  let hub: Record<string, unknown> = {};
  try {
    hub = JSON.parse(readFileSync(p.hubConfig, "utf8")) as Record<string, unknown>;
  } catch {
    /* no hub config */
  }
  const direct = Object.entries((hub.mcpServers as Record<string, Record<string, unknown>>) ?? {})
    .filter(([, e]) => typeof e.command === "string")
    .map(([name]) => ({ name, inManifest: Boolean(manifest.servers[name]) }));
  return { plugins, direct };
}

const DOCTOR_FLAGS: FlagSpec = { ...JSON_FLAG };

async function doctor(args: string[], io: Io): Promise<number> {
  const flags = parseFlags(args, DOCTOR_FLAGS, 0);
  const found = await bypassingServers(io.env);
  const { plugins, direct } = found;
  const code = plugins.length + direct.length ? 1 : 0;
  if (bool(flags, "json")) {
    printJson(io.out, { ok: code === 0, ...found });
    return code;
  }
  if (plugins.length) {
    io.out(paint(io, "Plugin servers that start in every session (they bypass mcpd):", "1"));
    for (const s of plugins) io.out(`  ${s.plugin}/${s.name}: ${s.command}  (tools ${s.toolPrefix}*)`);
    io.out("  Disable the plugin, or keep it if you need it everywhere. To keep its tools through mcpd,");
    io.out(`  declare [server.plugin_<plugin>_<name>] in mcp.toml so tool names stay the same.`);
  }
  if (direct.length) {
    io.out(paint(io, "Stdio servers still configured directly in plain claude (~/.claude.json):", "1"));
    for (const d of direct) io.out(`  ${d.name}${d.inManifest ? ": in mcp.toml, run turno mcp sync" : ": not in mcp.toml, run turno mcp import"}`);
  }
  if (!code) io.out("Every local server goes through mcpd.");
  return code;
}

// command ------------------------------------------------------------------------------------

const SUBS: Record<string, Sub> = {
  list: { synopsis: "[--json]", summary: "servers in mcp.toml and where they run", flags: flagsOf(LIST_FLAGS), run: list },
  sync: {
    synopsis: "[profile...] [--dry-run] [--force]",
    summary: "write gateway entries into every profile config",
    args: ["profile"],
    flags: flagsOf(SYNC_FLAGS),
    run: sync,
  },
  config: {
    synopsis: "--agent <a> [--profile <p>] [--json]",
    summary: "print gateway entries for other agents",
    flags: flagsOf(CONFIG_FLAGS),
    run: config,
  },
  import: {
    synopsis: "[--write] [--move-secrets] [--force]",
    summary: "draft mcp.toml from your agent configs",
    flags: flagsOf(IMPORT_FLAGS),
    run: importCmd,
  },
  install: {
    synopsis: "[server...] [--dry-run] [--allow-scripts]",
    summary: "install packages at exact versions",
    args: ["server"],
    flags: flagsOf(INSTALL_FLAGS),
    run: install,
  },
  refresh: { synopsis: "[server...] [--dry-run]", summary: "make mcpd relearn tool lists", args: ["server"], flags: flagsOf(REFRESH_FLAGS), run: refresh },
  doctor: { synopsis: "[--json]", summary: "find servers that bypass the gateway", flags: flagsOf(DOCTOR_FLAGS), run: doctor },
  daemon: {
    synopsis: "<start|stop|restart|status|logs>",
    summary: "the gateway daemon (same as turno mcpd)",
    args: ["any"],
    run: async (rest, io) => (await import("./mcpd.js")).command.run(rest, io),
  },
  token: {
    synopsis: "rotate [--dry-run]",
    summary: "replace the gateway token, then run turno mcp sync",
    args: ["any"],
    flags: ["--dry-run"],
    run: async (rest, io) => (await import("./mcpd.js")).tokenCommand.run(rest, io),
  },
};

export const command = group("mcp", "MCP servers behind the lazy gateway, and the gateway daemon itself", SUBS, {
  fallback: "list",
  footer: `config prints entries for ${SNIPPET_AGENTS.join(", ")}.
import reads ~/.claude.json, .mcp.json, ~/.codex, ~/.cursor and ~/.copilot.
It only previews, with secrets hidden, until --write.
Docs: docs/mcp.md in the turno repository.`,
});
