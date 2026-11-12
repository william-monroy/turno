import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../../core/config.js";
import { type StdioServer, loadManifest, parseManifest } from "../../core/manifest.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { type Command, type Io, fail, paint } from "../io.js";

const run = promisify(execFile);

const USAGE = `Usage:
  claudio mcp list                          servers in mcp.toml and where they run
  claudio mcp sync [profile...] [--dry-run] [--force]
                                            write the gateway entries into each profile config
  claudio mcp import [--write] [--force] [--move-secrets]
                                            draft mcp.toml from the current ~/.claude.json servers
  claudio mcp install [server...]           install declared packages (no npx at every start)
  claudio mcp refresh [server...]           forget cached tool lists (relearned on next use)
  claudio mcp doctor                        find servers that bypass the gateway`;

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function backupFile(file: string, env: NodeJS.ProcessEnv, label: string): string {
  const dir = join(paths(env).backupsDir, stamp());
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, label);
  copyFileSync(file, dest);
  return dest;
}

async function list(io: Io): Promise<number> {
  const m = loadManifest(io.env);
  const names = Object.keys(m.servers).sort();
  if (!names.length) {
    io.out(`no servers in ${tildify(paths(io.env).mcpFile, io.env)} (claudio mcp import)`);
    return 0;
  }
  for (const name of names) {
    const s = m.servers[name]!;
    const where = s.profiles.includes("*") ? "all profiles" : s.profiles.join(", ");
    if (s.kind === "remote") {
      io.out(`${paint(io, name, "1")}  remote ${s.proxy ? "via mcpd" : "direct"}  ${s.url}  (${where})`);
      continue;
    }
    const variants = Object.keys(s.variants);
    const installed = s.package && existsSync(join(paths(io.env).serversDir, s.name, "node_modules"));
    io.out(
      `${paint(io, name, "1")}  ${s.builtin ? `builtin ${s.builtin}` : s.command}  scope ${s.scope}${s.exclusive ? " exclusive" : ""}  idle ${Math.round(s.idle / 60)}m  (${where})` +
        (variants.length ? `  variants: ${variants.join(", ")}` : "") +
        (s.package ? `  package ${s.package}${installed ? "" : " (not installed)"}` : ""),
    );
  }
  return 0;
}

interface Target {
  profile: string;
  file: string;
}

function targets(io: Io, only: string[]): Target[] {
  const p = paths(io.env);
  const config = loadConfig(io.env);
  const out: Target[] = [];
  for (const name of listProfiles(config, io.env)) {
    if (only.length && !only.includes(name)) continue;
    out.push({ profile: name, file: join(profileDir(name, io.env), ".claude.json") });
  }
  // The hub config belongs to the system profile (plain `claude`).
  const hubProfile = config.system ?? "default";
  if ((!only.length || only.includes(hubProfile) || only.includes("hub")) && existsSync(p.hubConfig)) {
    out.push({ profile: hubProfile, file: p.hubConfig });
  }
  return out;
}

async function busySet(io: Io): Promise<Set<string>> {
  try {
    const mod = (await import("../../core/sessions.js")) as unknown as { busyProfiles?: (...a: unknown[]) => Set<string> | string[] };
    const res = mod.busyProfiles?.(loadConfig(io.env), io.env) ?? [];
    return new Set(res);
  } catch {
    return new Set();
  }
}

async function sync(args: string[], io: Io): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  const { profileServers, readManaged, syncConfigFile, writeManaged } = await import("../../mcpd/sync.js");
  const { ensureToken, mcpdPort } = await import("../../mcpd/daemon.js");
  const manifest = loadManifest(io.env);
  const token = ensureToken(io.env);
  const port = mcpdPort(io.env);
  const p = paths(io.env);
  const managed = readManaged(p.mcpdManaged);
  const busy = await busySet(io);
  let skipped = 0;
  for (const t of targets(io, only)) {
    const label = `${t.profile} (${tildify(t.file, io.env)})`;
    if (busy.has(t.profile) && !force && !dryRun) {
      io.out(`${paint(io, "skip", "33")} ${label}: has open sessions; close them or use --force`);
      skipped++;
      continue;
    }
    const wanted = profileServers(manifest, t.profile, port, token);
    if (existsSync(t.file) && !dryRun) backupFile(t.file, io.env, `${t.profile}.claude.json`);
    const res = syncConfigFile(t.file, wanted, managed[t.file] ?? [], { dryRun });
    if (!dryRun) managed[t.file] = Object.keys(wanted);
    const parts = [
      res.added.length ? `added ${res.added.join(", ")}` : "",
      res.updated.length ? `updated ${res.updated.join(", ")}` : "",
      res.removed.length ? `removed ${res.removed.join(", ")}` : "",
      res.foreign.length ? `left alone ${res.foreign.join(", ")}` : "",
    ].filter(Boolean);
    io.out(`${paint(io, dryRun ? "plan" : res.changed ? "sync" : "same", res.changed ? "32" : "2")} ${label}${parts.length ? `: ${parts.join("; ")}` : ""}`);
  }
  if (!dryRun) writeManaged(p.mcpdManaged, managed);
  if (!dryRun) io.out("New sessions pick this up; open sessions keep their old servers until restarted.");
  return skipped ? 1 : 0;
}

async function binOf(pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("npm", ["view", pkg, "bin", "--json"], { timeout: 20_000 });
    const bin = JSON.parse(stdout || "null") as string | Record<string, string> | null;
    if (!bin) return undefined;
    if (typeof bin === "string") return pkg.replace(/^@[^/]+\//, "");
    return Object.keys(bin)[0];
  } catch {
    return undefined;
  }
}

async function importCmd(args: string[], io: Io): Promise<number> {
  const { importServers } = await import("../../mcpd/importer.js");
  const { storeKeychainSecret } = await import("../../core/secrets.js");
  const p = paths(io.env);
  let hub: Record<string, unknown> = {};
  try {
    hub = JSON.parse(readFileSync(p.hubConfig, "utf8")) as Record<string, unknown>;
  } catch {
    return fail(`cannot read ${tildify(p.hubConfig, io.env)}`);
  }
  const servers = (hub.mcpServers as Record<string, Record<string, unknown>>) ?? {};
  const report = await importServers(servers, {
    moveSecrets: args.includes("--move-secrets"),
    binOf,
    store: (service, value) => storeKeychainSecret(service, value),
  });
  parseManifest(report.toml); // never write something we cannot read back
  for (const n of report.notes) io.err(`  ${n}`);
  for (const s of report.secretsMoved) io.err(`  moved ${s}`);
  if (report.literalSecrets.length) {
    io.err(`  ${paint(io, "warning", "33")}: literal secrets kept (${report.literalSecrets.join(", ")}); rerun with --move-secrets to store them in the Keychain`);
  }
  if (!args.includes("--write")) {
    io.out(report.toml);
    return 0;
  }
  if (existsSync(p.mcpFile) && !args.includes("--force")) return fail(`${tildify(p.mcpFile, io.env)} exists; use --force (it is backed up)`);
  if (existsSync(p.mcpFile)) io.err(`  backup: ${backupFile(p.mcpFile, io.env, "mcp.toml")}`);
  mkdirSync(p.config, { recursive: true });
  writeFileSync(p.mcpFile, report.toml, { mode: 0o600 });
  io.out(`wrote ${tildify(p.mcpFile, io.env)}`);
  return 0;
}

async function install(args: string[], io: Io): Promise<number> {
  const m = loadManifest(io.env);
  const p = paths(io.env);
  const wanted = Object.values(m.servers).filter(
    (s): s is StdioServer => s.kind === "stdio" && Boolean(s.package) && (!args.length || args.includes(s.name)),
  );
  if (!wanted.length) {
    io.out("nothing to install (no server declares a package)");
    return 0;
  }
  let failed = 0;
  for (const s of wanted) {
    const dir = join(p.serversDir, s.name);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), `{ "private": true }\n`);
    io.out(`installing ${s.package} for ${s.name}...`);
    try {
      await run("npm", ["install", "--no-audit", "--no-fund", "--prefix", dir, s.package!], { timeout: 300_000 });
      const bin = join(dir, "node_modules", ".bin", s.command);
      io.out(existsSync(bin) ? `  ok: ${tildify(bin, io.env)}` : `  ${paint(io, "warning", "33")}: installed but no bin named ${s.command}`);
    } catch (err) {
      failed++;
      io.err(`  failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return failed ? 1 : 0;
}

async function refresh(args: string[], io: Io): Promise<number> {
  const dir = paths(io.env).mcpdCacheDir;
  if (!existsSync(dir)) {
    io.out("cache is empty");
    return 0;
  }
  const { readdirSync } = await import("node:fs");
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!args.length || args.some((a) => f.startsWith(`${a}@`))) {
      rmSync(join(dir, f), { force: true });
      n++;
    }
  }
  io.out(`forgot ${n} cached descriptions; restart mcpd (claudio mcpd restart) so it relearns them`);
  return 0;
}

async function doctor(io: Io): Promise<number> {
  const { pluginServers } = await import("../../mcpd/importer.js");
  const p = paths(io.env);
  const manifest = loadManifest(io.env);
  let issues = 0;
  const plugins = pluginServers(p.hub);
  const stdio = plugins.filter((s) => s.transport === "stdio");
  if (stdio.length) {
    io.out(paint(io, "Plugin servers that start in every session (they bypass mcpd):", "1"));
    for (const s of stdio) io.out(`  ${s.plugin}/${s.name}: ${s.command}  (tools ${s.toolPrefix}*)`);
    io.out("  Disable the plugin, or keep it if you need it everywhere. To keep its tools through mcpd,");
    io.out(`  declare [server.plugin_<plugin>_<name>] in mcp.toml so tool names stay the same.`);
    issues += stdio.length;
  }
  let hub: Record<string, unknown> = {};
  try {
    hub = JSON.parse(readFileSync(p.hubConfig, "utf8")) as Record<string, unknown>;
  } catch {
    /* no hub config */
  }
  const direct = Object.entries((hub.mcpServers as Record<string, Record<string, unknown>>) ?? {}).filter(
    ([, e]) => typeof e.command === "string",
  );
  if (direct.length) {
    io.out(paint(io, "Stdio servers still configured directly in the hub config:", "1"));
    for (const [name] of direct) io.out(`  ${name}${manifest.servers[name] ? " (in mcp.toml: run claudio mcp sync)" : " (not in mcp.toml: claudio mcp import)"}`);
    issues += direct.length;
  }
  if (!issues) io.out("Every local server goes through mcpd.");
  return issues ? 1 : 0;
}

export const command: Command = {
  summary: "manage MCP servers behind the gateway",
  usage: USAGE,
  async run(args, io) {
    const [sub, ...rest] = args;
    switch (sub) {
      case "list":
      case undefined:
        return list(io);
      case "sync":
        return sync(rest, io);
      case "import":
        return importCmd(rest, io);
      case "install":
        return install(rest, io);
      case "refresh":
        return refresh(rest, io);
      case "doctor":
        return doctor(io);
      default:
        return fail(`unknown mcp command "${sub}"\n${USAGE}`);
    }
  },
};
