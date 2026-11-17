import { spawn } from "node:child_process";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isValidProfileName } from "../../core/config.js";
import { type RemoteServer, loadManifest, servesProfile, variantKey } from "../../core/manifest.js";
import { NO_SECRET_STORE, type SecretStore, keychainResolver, secretStore } from "../../core/secrets.js";
import { type LoginState, loginState, oauthService, parseRecord } from "../../mcpd/oauth.js";
import { DRY_RUN, type FlagSpec, JSON_FLAG, bool, parseFlags, printJson, str } from "../args.js";
import { type Io, fail } from "../io.js";

/**
 * `turno mcp login` and `turno mcp logout` (ADR 0029): mcpd is the OAuth client of remote
 * servers declared with `auth = "oauth"`, one login per server variant. Agents reach the server
 * through mcpd and never log in themselves.
 */

export const LOGIN_FLAGS: FlagSpec = { profile: { type: "string" }, scope: { type: "string" }, "no-browser": { type: "boolean" }, ...DRY_RUN, ...JSON_FLAG };
export const LOGOUT_FLAGS: FlagSpec = { profile: { type: "string" }, all: { type: "boolean" }, "no-revoke": { type: "boolean" }, ...DRY_RUN };

/** Seams for tests: how the authorization URL reaches a browser, and the HTTP client. */
export interface OAuthDeps {
  open?: (url: string, profile: string | undefined, io: Io) => void | Promise<void>;
  fetchFn?: FetchLike;
}

function oauthServer(env: NodeJS.ProcessEnv, name: string | undefined, verb: string): RemoteServer {
  if (!name) fail(`usage: turno mcp ${verb} <server> [--profile <p>]`);
  const def = loadManifest(env).servers[name];
  if (!def) fail(`no server "${name}" in mcp.toml`);
  if (def.kind !== "remote" || !def.oauth) fail(`${name} is not a remote server with auth = "oauth" in mcp.toml`);
  return def;
}

function variantFor(server: RemoteServer, profile: string | undefined): string {
  if (profile === undefined) return "default";
  if (!isValidProfileName(profile)) fail(`invalid profile name "${profile}"`);
  if (!servesProfile(server, profile)) fail(`${server.name} is not served to profile ${profile} (profiles in mcp.toml)`);
  return variantKey(server, profile);
}

function storeOf(env: NodeJS.ProcessEnv): SecretStore {
  const store = secretStore(env);
  if (!store) fail(NO_SECRET_STORE);
  return store;
}

/** Who a variant's login serves, for messages. */
function whom(server: RemoteServer, variant: string): string {
  if (variant !== "default") return `profile ${variant}`;
  return Object.keys(server.variants).length ? "every profile without its own variant" : "every profile";
}

/** Open the URL with the system browser (the profile's Chrome for claude.ai links, like turno open). */
async function openBrowser(url: string, profile: string | undefined, io: Io): Promise<void> {
  const { openInvocation } = await import("./open.js");
  const inv = openInvocation(profile, url, io.env);
  await new Promise<void>((resolve) => {
    const child = spawn(inv.command, inv.args, { stdio: "ignore", env: io.env, detached: true });
    child.on("error", () => resolve());
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function login(args: string[], io: Io, deps: OAuthDeps = {}): Promise<number> {
  const flags = parseFlags(args, LOGIN_FLAGS, 1);
  const server = oauthServer(io.env, flags.positionals[0], "login");
  const profile = str(flags, "profile");
  const variant = variantFor(server, profile);
  const store = storeOf(io.env);
  const json = bool(flags, "json");
  const noBrowser = bool(flags, "no-browser");
  const { login: run, OAuthFlowError } = await import("../../mcpd/oauth.js");
  const say = (line: string) => (json ? io.err(line) : io.out(line));
  try {
    const scope = str(flags, "scope");
    const result = await run({
      server,
      variant,
      store,
      resolve: keychainResolver(io.env),
      ...(scope ? { scope } : {}),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      dryRun: bool(flags, "dry-run"),
      open: async (url) => {
        if (noBrowser) {
          say(`Open this link in a browser to log in to ${server.name} (${whom(server, variant)}):`);
          say(url);
        } else {
          say(`Opening the browser to log in to ${server.name} (${whom(server, variant)}). If it does not open, visit:`);
          say(url);
          await (deps.open ?? openBrowser)(url, profile, io);
        }
        say("Waiting for the browser (Ctrl-C cancels)...");
      },
    });
    if (json) {
      printJson(io, { server: server.name, variant, ...result });
      return 0;
    }
    if (result.planned) {
      io.out(`would log in to ${server.name} (${whom(server, variant)}) through ${result.issuer}`);
      io.out(`  client: ${result.registration === "dynamic" ? "dynamic client registration" : result.registration === "metadata-document" ? "client ID metadata document" : "pre-registered client_id"}`);
      io.out(`  scope: ${result.scope ?? "(none requested)"}`);
      io.out(`  tokens would go to the ${store.label} as ${result.service}`);
      return 0;
    }
    io.out(`Logged in to ${server.name} for ${whom(server, variant)} through ${result.issuer}.`);
    io.out(`The tokens are in the ${store.label} as ${result.service}; mcpd refreshes them, and agents reach ${server.name} through mcpd.`);
    if (!result.refreshToken) io.out(`The server gave no refresh token: log in again when the access token expires.`);
    return 0;
  } catch (err) {
    if (err instanceof OAuthFlowError) fail(`login to ${server.name} failed: ${err.message}`);
    throw err;
  }
}

export async function logout(args: string[], io: Io, deps: OAuthDeps = {}): Promise<number> {
  const flags = parseFlags(args, LOGOUT_FLAGS, 1);
  const server = oauthServer(io.env, flags.positionals[0], "logout");
  const all = bool(flags, "all");
  if (all && str(flags, "profile") !== undefined) fail("use --all or --profile, not both");
  const variants = all ? ["default", ...Object.keys(server.variants)] : [variantFor(server, str(flags, "profile"))];
  const store = storeOf(io.env);
  const dry = bool(flags, "dry-run");
  const { revoke } = await import("../../mcpd/oauth.js");
  for (const variant of variants) {
    const service = oauthService(server.name, variant);
    const rec = parseRecord(await store.get(service));
    const label = `${server.name} (${whom(server, variant)})`;
    if (!rec && !(await store.has(service))) {
      io.out(`${label}: not logged in`);
      continue;
    }
    if (dry) {
      io.out(`would remove ${service} from the ${store.label}${rec?.tokens && !bool(flags, "no-revoke") ? ` and revoke the token at ${rec.issuer}` : ""}`);
      continue;
    }
    let revoked = "";
    if (rec?.tokens && !bool(flags, "no-revoke")) {
      const why = await revoke(server, rec, keychainResolver(io.env), deps.fetchFn);
      revoked = why ? `; could not revoke it at ${rec.issuer} (${why})` : `; revoked it at ${rec.issuer}`;
    }
    await store.remove(service);
    io.out(`Logged out of ${label}: removed ${service} from the ${store.label}${revoked}.`);
  }
  if (!dry) io.out("mcpd stops using the old token within a minute.");
  return 0;
}

export interface LoginRow {
  server: string;
  variant: string;
  state: LoginState;
  expiresAt?: number;
  refresh?: boolean;
}

/** Variants whose login is needed: "default" when some served profile has no variant of its own. */
export function loginVariants(server: RemoteServer): string[] {
  const own = Object.keys(server.variants);
  const needsDefault = server.profiles.includes("*") || server.profiles.some((p) => !server.variants[p]);
  return [...(needsDefault ? ["default"] : []), ...own];
}

/** The login state of every OAuth server variant (reads the secret store, never prints a token). */
export async function oauthLogins(env: NodeJS.ProcessEnv): Promise<LoginRow[]> {
  const servers = Object.values(loadManifest(env).servers).filter((s): s is RemoteServer => s.kind === "remote" && s.oauth !== undefined);
  if (!servers.length) return [];
  const store = secretStore(env);
  const rows: LoginRow[] = [];
  for (const s of servers) {
    for (const variant of loginVariants(s)) rows.push({ server: s.name, variant, ...(await loginState(store, s.name, variant)) });
  }
  return rows;
}

/** One short phrase per state, with the command that fixes it. */
export function describeLogin(r: LoginRow): string {
  const who = r.variant === "default" ? "" : ` --profile ${r.variant}`;
  switch (r.state) {
    case "logged in":
      return "logged in";
    case "expired":
      return "logged in (token refreshes on next use)";
    case "unknown":
      return "unknown (no secret store)";
    default:
      return `${r.state}: turno mcp login ${r.server}${who}`;
  }
}
