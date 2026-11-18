/**
 * `turno mcp export` and `turno mcp import <file>` (ADR 0050): move MCP servers between machines
 * without their secret values. The export is mcp.toml's own format; import also takes another
 * agent's MCP config file.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { isValidProfileName } from "../../core/config.js";
import { Journal } from "../../core/journal.js";
import { paths, tildify } from "../../core/paths.js";
import { type FlagSpec, JSON_FLAG, bool, parseFlags, str } from "../args.js";
import { nextStep } from "../hints.js";
import { type Io, CliError, fail, paint, plural } from "../io.js";
import { emit, jsonOutput } from "../output.js";

export const EXPORT_FLAGS: FlagSpec = { profile: { type: "string" }, ...JSON_FLAG };
export const EXPORT_JSON = jsonOutput(["profile", "servers", "keychain", "envVars", "moved", "redacted", "text"]);

/** `turno mcp export [--profile p]`: mcp.toml on stdout, each secret by name only. */
export async function exportCmd(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, EXPORT_FLAGS, 0);
  const profile = str(p, "profile");
  if (profile !== undefined && !isValidProfileName(profile)) fail(`invalid profile name: ${profile}`);
  const file = paths(io.env).mcpFile;
  if (!existsSync(file)) throw new CliError(`${tildify(file, io.env)} does not exist; nothing to export (turno mcp import drafts it)`);
  const { exportManifest } = await import("../../mcpd/share.js");
  const command = `turno mcp export${profile ? ` --profile ${profile}` : ""}`;
  const r = exportManifest(readFileSync(file, "utf8"), { ...(profile ? { profile } : {}), command });
  if (bool(p, "json")) {
    emit(io, p, EXPORT_JSON, { profile: profile ?? null, servers: r.servers, keychain: r.keychain, envVars: r.envVars, moved: r.moved, redacted: r.redacted, text: r.text });
    return 0;
  }
  io.out(r.text.replace(/\n$/, ""));
  // stderr: stdout is the file.
  io.err(`turno: exported ${plural(r.servers.length, "server")}${profile ? ` for ${profile}` : ""}, no secret values`);
  if (r.moved.length) io.err(`  literal secrets named as keychain references: ${r.moved.join(", ")}`);
  if (r.redacted.length) io.err(`  ${paint(io, "warning", "33")}: secrets in ${r.redacted.join(", ")} replaced by <secret>; fill them in by hand`);
  nextStep(io, "on the other machine, turno mcp import <file> --write, then the turno secret set lines at the top of the file", { stream: "err" });
  return 0;
}

export const IMPORT_FLAGS: FlagSpec = {
  write: { type: "boolean" },
  "move-secrets": { type: "boolean" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
};

/** The servers of `file`: mcp.toml's format, or an agent config converted like `turno mcp import` does. */
async function serversOf(file: string, io: Io, write: boolean, moveSecrets: boolean) {
  const { agentConfigServers, importServers, markOAuth, probeOAuth } = await import("../../mcpd/importer.js");
  const { manifestServers } = await import("../../mcpd/share.js");
  const shown = tildify(file, io.env);
  if (!existsSync(file)) throw new CliError(`no such file: ${shown}`);
  const text = readFileSync(file, "utf8");
  const probe = write ? { probeAuth: (url: string) => probeOAuth(url) } : {};
  let manifest = false;
  try {
    manifest = "server" in (parse(text) as Record<string, unknown>);
  } catch {
    /* not TOML */
  }
  if (manifest) {
    const servers = manifestServers(text, shown);
    const notes: string[] = [];
    if (probe.probeAuth) await markOAuth(servers, probe.probeAuth, notes);
    return { servers, notes, secrets: [], literalSecrets: [], from: "mcp.toml format" };
  }
  const found = agentConfigServers(text);
  if (!found) throw new CliError(`${shown} is not an mcp.toml (turno mcp export), a JSON file with mcpServers or a Codex config.toml with [mcp_servers]`);
  const { binOf } = await import("./mcp.js");
  const report = await importServers(found.servers, { moveSecrets, ...probe, ...(write ? { binOf: (pkg: string) => binOf(io, pkg) } : {}) });
  return { servers: manifestServers(report.toml, shown), notes: report.notes, secrets: report.secrets, literalSecrets: report.literalSecrets, from: `${found.agent} config` };
}

/** `turno mcp import <file>`: merge its servers into mcp.toml (a preview until --write). */
export async function importFile(file: string, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, IMPORT_FLAGS, 1);
  const write = bool(p, "write");
  const force = bool(p, "force");
  const moveSecrets = bool(p, "move-secrets");
  if (write && bool(p, "dry-run")) fail("--dry-run and --write do not go together (without --write it is a preview)");
  const target = paths(io.env).mcpFile;
  const r = await serversOf(file, io, write, moveSecrets);
  const names = Object.keys(r.servers);
  if (!names.length) {
    io.out(`no MCP servers in ${tildify(file, io.env)}; nothing to import`);
    return write ? 1 : 0;
  }
  const { mergeServers } = await import("../../mcpd/share.js");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  let merged: ReturnType<typeof mergeServers>;
  try {
    merged = mergeServers(existing, r.servers, force);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  io.err(`found ${plural(names.length, "server")} in ${tildify(file, io.env)} (${r.from})`);
  for (const n of r.notes) io.err(`  ${n}`);
  if (r.literalSecrets.length) io.err(`  ${paint(io, "warning", "33")}: literal secrets kept (${r.literalSecrets.join(", ")}); add --move-secrets to store them in the Keychain`);
  const verb = write ? ["added", "replaced", "kept"] : ["would add", "would replace", "would keep"];
  const lines = [
    merged.added.length ? `${verb[0]} ${merged.added.join(", ")}` : "",
    merged.replaced.length ? `${verb[1]} ${merged.replaced.join(", ")}` : "",
    merged.kept.length ? `${verb[2]} ${merged.kept.join(", ")} (already in mcp.toml; --force replaces them)` : "",
  ].filter(Boolean);
  if (!write) {
    for (const l of lines) io.out(l);
    for (const s of r.secrets) io.err(`  would move ${s.where} to keychain:${s.service}`);
    io.err(`Nothing written. Write it with: turno mcp import ${file} --write${moveSecrets ? " --move-secrets" : ""}${merged.kept.length ? " [--force]" : ""}`);
    return 0;
  }
  if (!merged.added.length && !merged.replaced.length) {
    for (const l of lines) io.out(l);
    return 0;
  }
  const { storeKeychainSecret } = await import("../../core/secrets.js");
  for (const s of r.secrets) {
    if (s.value.includes("${")) continue;
    await storeKeychainSecret(s.service, s.value, io.env);
    io.err(`  moved ${s.where} to keychain:${s.service}`);
  }
  const journal = new Journal(io.env, `mcp import ${file} --write`);
  journal.write(target, merged.text, 0o600);
  for (const l of lines) io.out(l);
  io.out(`wrote ${tildify(target, io.env)}`);
  io.out(journal.hint()!);
  nextStep(io, importNextSteps(merged.text, [...merged.added, ...merged.replaced]));
  return 0;
}

/** What to run after importing `names`: secrets to store, packages to pin, logins, then sync. */
export function importNextSteps(text: string, names: readonly string[]): string[] {
  const steps: string[] = [];
  const keychain = new Set<string>();
  let packages = false;
  const logins: string[] = [];
  // Read back what was written, so the steps match the file.
  const raw = parseRaw(text);
  for (const n of names) {
    const s = raw[n] ?? {};
    if (typeof s.package === "string") packages = true;
    if (s.auth === "oauth") logins.push(n);
    const variants = s.variant && typeof s.variant === "object" ? Object.values(s.variant as Record<string, Record<string, unknown>>) : [];
    for (const t of [s, ...variants]) {
      for (const key of ["env", "headers"]) {
        const m = t?.[key];
        if (m && typeof m === "object") for (const v of Object.values(m)) if (typeof v === "string" && v.startsWith("keychain:")) keychain.add(v.slice(9));
      }
    }
  }
  if (keychain.size) steps.push(`turno secret list shows which of ${plural(keychain.size, "keychain reference")} still need turno secret set`);
  if (packages) steps.push("turno mcp install pins and installs the packages");
  if (logins.length) steps.push(`turno mcp login ${logins.join(", ")} (one login each)`);
  steps.push("turno mcp sync points your profiles at them");
  return steps;
}

function parseRaw(text: string): Record<string, Record<string, unknown>> {
  const raw = parse(text) as Record<string, unknown>;
  return (raw.server ?? {}) as Record<string, Record<string, unknown>>;
}
