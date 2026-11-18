import { chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { paths, tildify } from "../core/paths.js";
import { setValue } from "../core/toml-edit.js";
import { type AgentAdapter, type RuleFoldersStep, type SafePlan, type SafeStep, type SetupStep, TOML_MCP_SERVERS, gatewayNames, gatewayUrl } from "./adapter.js";

/** A Codex `[mcp_servers.<name>]` table in Claude Code's shape. */
function fromCodex(e: Record<string, unknown>): Record<string, unknown> {
  if (typeof e.command === "string") {
    const env: Record<string, string> = { ...((e.env as Record<string, string>) ?? {}) };
    for (const v of (e.env_vars as unknown[]) ?? []) if (typeof v === "string") env[v] = `\${${v}}`;
    return {
      type: "stdio",
      command: e.command,
      args: (e.args as unknown[]) ?? [],
      ...(Object.keys(env).length ? { env } : {}),
      ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
    };
  }
  const headers: Record<string, string> = { ...((e.http_headers as Record<string, string>) ?? {}) };
  for (const [h, v] of Object.entries((e.env_http_headers as Record<string, string>) ?? {})) headers[h] = `\${${v}}`;
  if (typeof e.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${e.bearer_token_env_var}}`;
  return { type: "http", url: e.url, ...(Object.keys(headers).length ? { headers } : {}) };
}

/**
 * Codex profiles: seed config.toml from the hub once, and always store the login in the
 * profile (`cli_auth_credentials_store = "file"`), so each CODEX_HOME has its own account.
 */
function prepareConfig(s: SetupStep): void {
  const file = join(s.dir, "config.toml");
  let text = "";
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else {
    const hubFile = join(s.hub, "config.toml");
    if (existsSync(hubFile)) {
      text = readFileSync(hubFile, "utf8");
      s.out("  + config.toml from ~/.codex (the login is not copied)");
    }
  }
  const next = setValue(text, undefined, "cli_auth_credentials_store", "file");
  if (next !== text || !existsSync(file)) {
    s.writeOwn(file, next);
    s.out('  + cli_auth_credentials_store = "file" (the login stays in this profile)');
  }
  chmodSync(file, 0o600);
}

/**
 * Codex asks whether to trust a folder the first time it starts there, per CODEX_HOME, so a new
 * profile asks again for folders the person already trusted. turno writes
 * `[projects."<folder>"] trust_level = "trusted"` for each folder whose rule uses the profile,
 * and the real path too when a symlink leads there. Codex matches the exact folder, or the git
 * root of the folder it runs in (the main repository for a worktree); a rule on a parent of
 * several repositories does not trust the repositories inside it. An entry already there,
 * trusted or not, is never changed.
 */
export function trustFolders(s: RuleFoldersStep): void {
  const file = join(s.dir, "config.toml");
  if (!s.folders.length || !existsSync(s.dir)) return;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  let projects: Record<string, unknown> = {};
  try {
    const raw = parseToml(text) as Record<string, unknown>;
    if (raw.projects && typeof raw.projects === "object") projects = raw.projects as Record<string, unknown>;
  } catch {
    s.out("  ! config.toml does not parse; no trust entries written");
    return;
  }
  const wanted = new Set<string>();
  for (const f of s.folders) {
    wanted.add(f);
    try {
      wanted.add(realpathSync(f));
    } catch {
      /* not there yet: the rule's path only */
    }
  }
  let next = text;
  const added: string[] = [];
  for (const f of wanted) {
    if (f in projects) continue;
    next = setValue(next, `projects.${JSON.stringify(f)}`, "trust_level", "trusted");
    added.push(f);
  }
  if (!added.length) return;
  try {
    const check = (parseToml(next) as { projects?: Record<string, { trust_level?: string }> }).projects ?? {};
    if (added.some((f) => check[f]?.trust_level !== "trusted")) throw new Error("trust entry not readable");
  } catch {
    s.out("  ! could not write the Codex trust entries; trust the folders in Codex when it asks");
    return;
  }
  s.writeOwn(file, next);
  for (const f of added) s.out(`  + trusts ${tildify(f, s.env)} in Codex (its folder rule uses this profile)`);
}

/** Safe mode: `-c mcp_servers.<name>.enabled=false` for each gateway entry of config.toml. */
function safeMode(s: SafeStep): SafePlan {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = parseToml(readFileSync(s.file, "utf8")) as Record<string, unknown>;
  } catch {
    /* no config: nothing to turn off */
  }
  const names = gatewayNames(cfg.mcp_servers);
  // `-c` splits its key at dots, so a name with one cannot be addressed; mcpd refuses it anyway
  // (safe mode leaves the token out).
  const plain = names.filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
  const odd = names.filter((n) => !plain.includes(n));
  return {
    args: plain.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]),
    notes: [
      plain.length ? `turned off the gateway entries ${plain.join(", ")} for this run` : "no gateway entries to turn off",
      ...(odd.length ? [`${odd.join(", ")}: a name with a dot cannot be turned off for one run; without the token mcpd refuses it`] : []),
    ],
  };
}

export const codex: AgentAdapter = {
  id: "codex",
  label: "Codex CLI",
  command: "codex",
  homeEnv: "CODEX_HOME",
  dirPrefix: ".codex-",
  launcherPrefix: "codex-",
  install: "npm install --global @openai/codex",
  loginSubcommand: "login",
  hub: (env) => join(paths(env).home, ".codex"),
  homeMarkers: ["config.toml", "auth.json", "sessions", "history.jsonl"],
  // Rollouts in sessions/ let `codex resume <id>` continue a session with another account
  // (not verified across ChatGPT accounts yet; ADR 0013).
  sharedDirs: ["sessions", "prompts", "skills"],
  sharedFiles: ["AGENTS.md"],
  launcherEnv: {},
  classicLauncher: false,
  tokenFromEnv: true,
  accountDetails: false,
  mcp: {
    store: TOML_MCP_SERVERS,
    file: (dir) => join(dir, "config.toml"),
    shared: false,
    hubFile: (env) => join(codex.hub(env), "config.toml"),
    toImport: fromCodex,
    directRemote: false,
    // The token and the session PID come from the launcher's environment, never the file.
    gatewayEntry: (name, port, _token, profile) => ({
      url: gatewayUrl(name, port),
      bearer_token_env_var: "TURNO_MCPD_TOKEN",
      http_headers: { "X-Turno-Profile": profile },
      env_http_headers: { "X-Turno-Pid": "TURNO_SESSION_PID", "X-Turno-Cwd-B64": "TURNO_SESSION_CWD_B64" },
    }),
  },
  safeMode,
  ruleFolders: trustFolders,
  setup: { after: prepareConfig },
  doctorWarnings(dir) {
    let store: unknown;
    try {
      store = (parseToml(readFileSync(join(dir, "config.toml"), "utf8")) as Record<string, unknown>).cli_auth_credentials_store;
    } catch {
      store = undefined;
    }
    return store === "file" ? [] : ['Codex may keep the login in the shared Keychain (cli_auth_credentials_store is not "file")'];
  },
};
