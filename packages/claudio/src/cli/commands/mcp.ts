import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../../core/config.js";
import { type StdioServer, loadManifest, parseManifest } from "../../core/manifest.js";
import { Journal } from "../../core/journal.js";
import { paths, profileDir, tildify } from "../../core/paths.js";
import { listProfiles } from "../../core/profiles.js";
import { type Command, type Io, fail, paint } from "../io.js";

const run = promisify(execFile);

const USAGE = `Usage:
  claudio mcp list [--json]                 servers in mcp.toml and where they run
  claudio mcp sync [profile...] [--dry-run] [--force]
                                            write the gateway entries into each profile config
  claudio mcp import [--write] [--force] [--move-secrets]
                                            draft mcp.toml from the current ~/.claude.json servers
  claudio mcp install [server...]           install declared packages (no npx at every start)
  claudio mcp refresh [server...]           forget cached tool lists (relearned on next use)
  claudio mcp doctor                        find servers that bypass the gateway
  claudio mcp daemon <start|stop|restart|status|logs|run>
                                            the gateway daemon (claudio mcpd is the same)`;

async function list(io: Io, json = false): Promise<number> {
  const m = loadManifest(io.env);
  const names = Object.keys(m.servers).sort();
  if (json) {
    io.out(
      JSON.stringify(
        names.map((n) => {
          const s = m.servers[n]!;
          return s.kind === "remote"
            ? { name: n, kind: "remote", url: s.url, proxy: Boolean(s.proxy), profiles: s.profiles }
            : { name: n, kind: "stdio", command: s.builtin ? `builtin ${s.builtin}` : s.command, scope: s.scope, exclusive: Boolean(s.exclusive), idleSeconds: s.idle, profiles: s.profiles, package: s.package ?? null, variants: Object.keys(s.variants) };
        }),
        null,
        2,
      ),
    );
    return 0;
  }
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
  const journal = new Journal(io.env, `mcp sync ${args.join(" ")}`.trim(), dryRun);
  for (const t of targets(io, only)) {
    const label = `${t.profile} (${tildify(t.file, io.env)})`;
    if (busy.has(t.profile) && !force && !dryRun) {
      io.out(`${paint(io, "skip", "33")} ${label}: has open sessions; close them or use --force`);
      skipped++;
      continue;
    }
    const wanted = profileServers(manifest, t.profile, port, token);
    const before = journal.save(t.file);
    const res = syncConfigFile(t.file, wanted, managed[t.file] ?? [], { dryRun });
    journal.settle(before);
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
  const hint = journal.hint();
  if (hint) io.out(hint);
  return skipped ? 1 : 0;
}

/** The bin npx would run: the only one, else the one named after the package. */
export function pickBin(pkg: string, bin: string | Record<string, string>): string | undefined {
  const base = pkg.replace(/^@[^/]+\//, "");
  if (typeof bin === "string") return base;
  const names = Object.keys(bin);
  if (names.length === 1) return names[0];
  return names.find((n) => n === base) ?? names.find((n) => n.includes("mcp"));
}

async function binOf(pkg: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("npm", ["view", pkg, "bin", "--json"], { timeout: 20_000 });
    const bin = JSON.parse(stdout || "null") as string | Record<string, string> | null;
    if (!bin) return undefined;
    return pickBin(pkg, bin);
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
  const journal = new Journal(io.env, "mcp import --write");
  journal.write(p.mcpFile, report.toml, 0o600);
  io.out(`wrote ${tildify(p.mcpFile, io.env)}`);
  io.out(journal.hint()!);
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

async function doctor(io: Io): Promise<number> {
  const { plugins, direct } = await bypassingServers(io.env);
  if (plugins.length) {
    io.out(paint(io, "Plugin servers that start in every session (they bypass mcpd):", "1"));
    for (const s of plugins) io.out(`  ${s.plugin}/${s.name}: ${s.command}  (tools ${s.toolPrefix}*)`);
    io.out("  Disable the plugin, or keep it if you need it everywhere. To keep its tools through mcpd,");
    io.out(`  declare [server.plugin_<plugin>_<name>] in mcp.toml so tool names stay the same.`);
  }
  if (direct.length) {
    io.out(paint(io, "Stdio servers still configured directly in the hub config:", "1"));
    for (const d of direct) io.out(`  ${d.name}${d.inManifest ? " (in mcp.toml: run claudio mcp sync)" : " (not in mcp.toml: claudio mcp import)"}`);
  }
  if (!plugins.length && !direct.length) io.out("Every local server goes through mcpd.");
  return plugins.length + direct.length ? 1 : 0;
}

export const command: Command = {
  summary: "MCP servers behind the lazy gateway, and the gateway daemon itself",
  usage: USAGE,
  subcommands: {
    list: { flags: ["--json"] },
    sync: { args: ["profile"], flags: ["--dry-run", "--force"] },
    import: { flags: ["--write", "--force", "--move-secrets"] },
    install: { args: ["server"] },
    refresh: { args: ["server"] },
    doctor: {},
    daemon: { args: ["any"] },
  },
  async run(args, io) {
    const [sub, ...rest] = args;
    switch (sub) {
      case "list":
      case undefined:
        return list(io, rest.includes("--json"));
      case "sync":
        return sync(rest, io);
      case "import":
        return importCmd(rest, io);
      case "install":
        return install(rest, io);
      case "refresh":
        return refresh(rest, io);
      case "daemon":
        return (await import("./mcpd.js")).command.run(rest, io);
      case "doctor":
        return doctor(io);
      default:
        return fail(`unknown mcp command "${sub}"\n${USAGE}`);
    }
  },
};
