import { createHash, randomBytes } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  isHttpsUrl,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  OAuthMetadataSchema,
  type OAuthProtectedResourceMetadata,
  type OAuthTokens,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthSettings, RemoteServer } from "../core/manifest.js";
import type { SecretResolver, SecretStore } from "../core/secrets.js";
import { packageInfo } from "../core/version.js";

/**
 * mcpd as the OAuth client of remote MCP servers, following the MCP authorization
 * specification (revision 2026-07-28): protected resource metadata (RFC 9728), authorization
 * server metadata (RFC 8414, OpenID Connect Discovery) with issuer validation, pre-registration,
 * Client ID Metadata Documents or Dynamic Client Registration (RFC 7591), PKCE with S256
 * (RFC 7636), resource indicators (RFC 8707), and issuer identification in the authorization
 * response (RFC 9207). The SDK's building blocks do the HTTP; the checks the SDK leaves out
 * (issuer echo, PKCE advertised, `iss`, HTTPS endpoints) are here.
 *
 * Tokens live only in the secret store (one item per server variant) and in mcpd's memory.
 * They are never written to a file, a log line or command output.
 */

/** Seconds before `expires_at` when an access token already counts as expired. */
const EXPIRY_SKEW_MS = 60_000;
/** How long mcpd trusts its copy of a login before it looks at the secret store again. */
const RECHECK_MS = 60_000;
const CALLBACK_PATH = "/callback";

/** Secret store item that holds the login of one server variant. */
export function oauthService(server: string, variant: string): string {
  return `turno/oauth/${server}@${variant}`;
}

/** What `turno mcp login` passes to an authorization server about turno. */
function clientMetadata(redirectUri: string, scope?: string): OAuthClientMetadata & { application_type: string } {
  return {
    client_name: "turno",
    client_uri: "https://github.com/wimo-dev/turno",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    // The MCP spec asks for it with DCR: a CLI on a loopback redirect is a native application.
    application_type: "native",
    software_id: "turno",
    software_version: packageInfo().version,
    ...(scope ? { scope } : {}),
  };
}

export interface StoredTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** Milliseconds since the epoch; absent when the server gave no expires_in. */
  expires_at?: number;
}

type Registration = "pre-registered" | "metadata-document" | "dynamic";

/** The JSON kept in one secret store item (one line, so the Keychain store can take it). */
export interface OAuthRecord {
  v: 1;
  /** The authorization server's issuer: client and tokens are bound to it. */
  issuer: string;
  /** RFC 8707 resource the tokens are for (the MCP server's canonical URI). */
  resource: string;
  /** Scopes asked for at login, kept so a step-up login can add to them. */
  scope?: string;
  registration: Registration;
  /** Client information; for a pre-registered client only its id (the secret stays in mcp.toml). */
  client: OAuthClientInformationMixed;
  /** Absent once the authorization server rejected the refresh token: a login is needed. */
  tokens?: StoredTokens;
  savedAt: number;
}

export function parseRecord(raw: string | undefined): OAuthRecord | undefined {
  if (!raw) return undefined;
  try {
    const r = JSON.parse(raw) as OAuthRecord;
    return r && r.v === 1 && typeof r.issuer === "string" && r.client && typeof r.client.client_id === "string"
      ? r
      : undefined;
  } catch {
    return undefined;
  }
}

/** The OAuth error a session raises when nobody can fix it but the user, with the command to run. */
export class LoginRequiredError extends Error {
  constructor(server: string, variant: string, why: string) {
    const who = variant === "default" ? "" : ` --profile ${variant}`;
    super(
      `${server}${variant === "default" ? "" : `@${variant}`} needs a login (${why}): run turno mcp login ${server}${who}`,
    );
    this.name = "LoginRequiredError";
  }
}

export class OAuthFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackUrl(url: string | URL): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** HTTPS, or plain HTTP on the loopback interface (local servers and tests). */
function requireSecure(url: string, what: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OAuthFlowError(`${what} is not a URL: ${url}`);
  }
  if (u.protocol !== "https:" && !isLoopbackUrl(u)) throw new OAuthFlowError(`${what} must use https: ${url}`);
}

/** Error text with every known secret value replaced, cut to one short line. */
function scrub(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

export interface Discovery {
  resourceMetadata: OAuthProtectedResourceMetadata;
  /** The `resource` parameter, sent verbatim (RFC 8707). */
  resource: string;
  /** The selected authorization server's issuer identifier. */
  issuer: string;
  metadata: AuthorizationServerMetadata;
  /** Scope from the 401 challenge, when the probe got one. */
  challengeScope?: string;
}

/** RFC 7009 endpoint; OAuth metadata has it, the OpenID type does not declare it. */
function revocationEndpoint(m: AuthorizationServerMetadata): string | undefined {
  const v = (m as { revocation_endpoint?: unknown }).revocation_endpoint;
  return typeof v === "string" ? v : undefined;
}

function sameIssuer(advertised: string, used: string): boolean {
  // RFC 8414 section 3.3: identical. A lone trailing slash on a pathless issuer builds the same
  // well-known URL, so it is the one difference tolerated.
  if (advertised === used) return true;
  const strip = (s: string) => (s.endsWith("/") && new URL(s).pathname === "/" ? s.slice(0, -1) : s);
  try {
    return strip(advertised) === strip(used);
  } catch {
    return false;
  }
}

/**
 * Authorization server metadata, from the well-known URLs in the order the spec gives (RFC 8414
 * first, then OpenID Connect Discovery). The document's `issuer` must be the one the URL was
 * built from, and it must advertise PKCE with S256; otherwise turno refuses to go on.
 */
async function authorizationServerMetadata(
  issuer: string,
  fetchFn: FetchLike = fetch,
): Promise<AuthorizationServerMetadata> {
  requireSecure(issuer, "the authorization server");
  for (const { url, type } of buildDiscoveryUrls(issuer)) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { Accept: "application/json", "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION },
        redirect: "error",
      });
    } catch (err) {
      throw new OAuthFlowError(`cannot reach the authorization server at ${url.origin}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status < 500) continue;
      throw new OAuthFlowError(`HTTP ${res.status} from ${url.href}`);
    }
    const parsed = (type === "oauth" ? OAuthMetadataSchema : OpenIdProviderDiscoveryMetadataSchema).safeParse(
      await res.json().catch(() => null),
    );
    if (!parsed.success) throw new OAuthFlowError(`${url.href} is not valid authorization server metadata`);
    const m = parsed.data as AuthorizationServerMetadata;
    if (!sameIssuer(m.issuer, issuer)) {
      throw new OAuthFlowError(
        `the metadata at ${url.href} names issuer ${m.issuer}, not ${issuer}; refusing to use it (RFC 8414 section 3.3)`,
      );
    }
    if (!m.code_challenge_methods_supported?.includes("S256")) {
      throw new OAuthFlowError(
        `the authorization server ${issuer} does not advertise PKCE with S256 (code_challenge_methods_supported); refusing to go on`,
      );
    }
    if (!m.response_types_supported.includes("code"))
      throw new OAuthFlowError(`the authorization server ${issuer} does not support the authorization code flow`);
    for (const [k, v] of Object.entries({
      authorization_endpoint: m.authorization_endpoint,
      token_endpoint: m.token_endpoint,
      registration_endpoint: m.registration_endpoint,
      revocation_endpoint: revocationEndpoint(m),
    })) {
      if (typeof v === "string") requireSecure(v, k);
    }
    return m;
  }
  throw new OAuthFlowError(`no authorization server metadata found for ${issuer}`);
}

/** POST an unauthenticated initialize to learn the 401 challenge (resource_metadata, scope). */
async function probe(
  serverUrl: string,
  fetchFn: FetchLike,
): Promise<{ status: number; resourceMetadataUrl?: URL; scope?: string }> {
  let res: Response;
  try {
    res = await fetchFn(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "turno-mcpd", version: packageInfo().version },
        },
      }),
      redirect: "error",
    });
  } catch (err) {
    throw new OAuthFlowError(`cannot reach ${serverUrl}: ${(err as Error).message}`);
  }
  const params = res.status === 401 ? extractWWWAuthenticateParams(res) : {};
  await res.body?.cancel().catch(() => {});
  return { status: res.status, ...params };
}

/**
 * Find the authorization server of an MCP server. With `challenge`, first send an
 * unauthenticated request and use the resource_metadata URL and scope of its 401; without one
 * (refresh), go straight to the well-known URLs.
 */
async function discover(
  server: RemoteServer,
  fetchFn: FetchLike = fetch,
  challenge = false,
): Promise<Discovery & { unprotected?: boolean }> {
  requireSecure(server.url, `${server.name}'s url`);
  let resourceMetadataUrl: URL | undefined;
  let challengeScope: string | undefined;
  if (challenge) {
    const p = await probe(server.url, fetchFn);
    if (p.status >= 200 && p.status < 300) return { unprotected: true } as Discovery & { unprotected: true };
    resourceMetadataUrl = p.resourceMetadataUrl;
    challengeScope = p.scope;
  }
  let resourceMetadata: OAuthProtectedResourceMetadata;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      server.url,
      resourceMetadataUrl ? { resourceMetadataUrl } : {},
      fetchFn,
    );
  } catch (err) {
    throw new OAuthFlowError(
      `${server.name} does not publish OAuth protected resource metadata (RFC 9728): ${(err as Error).message}`,
    );
  }
  const requested = resourceUrlFromServerUrl(server.url);
  if (!checkResourceAllowed({ requestedResource: requested, configuredResource: resourceMetadata.resource })) {
    throw new OAuthFlowError(
      `${server.name}: the protected resource ${resourceMetadata.resource} does not cover ${server.url}`,
    );
  }
  const listed = resourceMetadata.authorization_servers ?? [];
  if (!listed.length)
    throw new OAuthFlowError(`${server.name}: the protected resource metadata lists no authorization server`);
  const wanted = server.oauth?.authorizationServer;
  const issuer = wanted ? listed.find((a) => sameIssuer(a, wanted)) : listed[0];
  if (!issuer)
    throw new OAuthFlowError(`${server.name}: authorization_server ${wanted} is not one of ${listed.join(", ")}`);
  const metadata = await authorizationServerMetadata(issuer, fetchFn);
  return {
    resourceMetadata,
    resource: resourceMetadata.resource,
    issuer,
    metadata,
    ...(challengeScope ? { challengeScope } : {}),
  };
}

/** Space-separated union, keeping the first order. */
function unionScopes(...lists: (string | undefined)[]): string | undefined {
  const out: string[] = [];
  for (const l of lists) for (const s of (l ?? "").split(/\s+/)) if (s && !out.includes(s)) out.push(s);
  return out.length ? out.join(" ") : undefined;
}

/** Scope selection of the spec: configured, else the 401 challenge, else scopes_supported. */
function selectScope(
  d: Discovery,
  settings: OAuthSettings | undefined,
  extra?: string,
  previous?: string,
): string | undefined {
  const base = settings?.scope ?? d.challengeScope ?? d.resourceMetadata.scopes_supported?.join(" ");
  let scope = unionScopes(previous, base, extra);
  // Refresh tokens are not a resource scope; ask for offline_access only when the server lists it.
  if (scope && d.metadata.scopes_supported?.includes("offline_access")) scope = unionScopes(scope, "offline_access");
  return scope;
}

function toStored(t: OAuthTokens, now: number): StoredTokens {
  return {
    access_token: t.access_token,
    token_type: t.token_type,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    ...(t.scope ? { scope: t.scope } : {}),
    ...(typeof t.expires_in === "number" && Number.isFinite(t.expires_in)
      ? { expires_at: now + t.expires_in * 1000 }
      : {}),
  };
}

/** The client information to present: pre-registered ones get their secret from mcp.toml at use time. */
async function clientFor(
  rec: OAuthRecord,
  settings: OAuthSettings | undefined,
  resolve: SecretResolver,
): Promise<OAuthClientInformationMixed> {
  if (rec.registration !== "pre-registered") return rec.client;
  return {
    client_id: rec.client.client_id,
    ...(settings?.clientSecret ? { client_secret: await resolve(settings.clientSecret) } : {}),
  };
}

// login ----------------------------------------------------------------------------------------

export interface LoginOptions {
  server: RemoteServer;
  variant: string;
  store: SecretStore;
  resolve: SecretResolver;
  /** Hands the authorization URL to the user (browser, or printed). */
  open: (url: string) => void | Promise<void>;
  /** Scopes to add to what is selected (step-up). */
  scope?: string;
  fetchFn?: FetchLike;
  /** How long to wait for the browser to come back (default 5 minutes). */
  timeoutMs?: number;
  now?: () => number;
  /** Plan only: discovery and registration choice, no browser, nothing stored. */
  dryRun?: boolean;
}

export interface LoginResult {
  issuer: string;
  registration: Registration;
  scope?: string;
  redirectUri?: string;
  expiresAt?: number;
  refreshToken: boolean;
  service: string;
  /** Dry run: what would happen. */
  planned?: boolean;
}

interface Callback {
  port: number;
  redirectUri: string;
  /** Resolves with the query of the first request to the callback path. */
  wait: (timeoutMs: number) => Promise<URLSearchParams>;
  close: () => Promise<void>;
}

/** A one-shot HTTP listener on 127.0.0.1 (RFC 8252 section 7.3, loopback IP literal). */
async function callbackServer(port: number): Promise<Callback> {
  let deliver!: (q: URLSearchParams) => void;
  const got = new Promise<URLSearchParams>((r) => {
    deliver = r;
  });
  const srv: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      "<!doctype html><title>turno</title><p>turno received the answer. You can close this tab and go back to the terminal.</p>",
    );
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (srv.address() as AddressInfo).port;
  return {
    port: actual,
    redirectUri: `http://127.0.0.1:${actual}${CALLBACK_PATH}`,
    wait: (timeoutMs) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new OAuthFlowError(`no answer from the browser within ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs,
        );
        void got.then((q) => {
          clearTimeout(t);
          resolve(q);
        });
      }),
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}

function portOf(uris: unknown): number | undefined {
  if (!Array.isArray(uris)) return undefined;
  for (const u of uris) {
    try {
      const url = new URL(String(u));
      if (url.hostname === "127.0.0.1" && url.port) return Number(url.port);
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

/**
 * RFC 9207 section 2.4, as the MCP spec tabulates it: a present `iss` must equal the recorded
 * issuer (simple string comparison); an absent one is refused only when the server says it sends it.
 */
export function checkIssuerParam(q: URLSearchParams, issuer: string, metadata: AuthorizationServerMetadata): void {
  const iss = q.get("iss");
  const advertised =
    (metadata as { authorization_response_iss_parameter_supported?: unknown })
      .authorization_response_iss_parameter_supported === true;
  if (iss !== null) {
    if (iss !== issuer)
      throw new OAuthFlowError(
        `the authorization response came from issuer ${iss}, not ${issuer}; refusing it (RFC 9207)`,
      );
    return;
  }
  if (advertised)
    throw new OAuthFlowError(
      `the authorization response has no iss although ${issuer} advertises it; refusing it (RFC 9207)`,
    );
}

/**
 * `turno mcp login`: discovery, client registration, PKCE authorization code flow on a loopback
 * redirect, token exchange, and one write to the secret store.
 */
export async function login(o: LoginOptions): Promise<LoginResult> {
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const settings = o.server.oauth;
  const service = oauthService(o.server.name, o.variant);
  const d = await discover(o.server, fetchFn, true);
  if (d.unprotected)
    throw new OAuthFlowError(
      `${o.server.name} answered without asking for authorization; it needs no login (remove auth = "oauth")`,
    );
  const previous = parseRecord(await o.store.get(service));
  const sameAs = previous && sameIssuer(previous.issuer, d.issuer) ? previous : undefined;
  const scope = selectScope(d, settings, o.scope, o.scope ? sameAs?.scope : undefined);

  // Registration, in the spec's order: pre-registered, metadata document, dynamic.
  let registration: Registration;
  if (settings?.clientId) registration = "pre-registered";
  else if (d.metadata.client_id_metadata_document_supported === true && settings?.clientMetadataUrl)
    registration = "metadata-document";
  else if (d.metadata.registration_endpoint) registration = "dynamic";
  else {
    throw new OAuthFlowError(
      `${d.issuer} offers neither dynamic client registration nor client ID metadata documents that turno can use; register a client there and set client_id under [server.${o.server.name}.oauth]`,
    );
  }
  if (registration === "metadata-document" && !isHttpsUrl(settings?.clientMetadataUrl)) {
    throw new OAuthFlowError(`client_metadata_url must be an https URL with a path`);
  }
  if (o.dryRun)
    return { issuer: d.issuer, registration, ...(scope ? { scope } : {}), refreshToken: false, service, planned: true };

  // Reuse the port of an earlier dynamic registration, so its exact redirect URI still matches.
  const reusable = registration === "dynamic" && sameAs?.registration === "dynamic" ? sameAs.client : undefined;
  const wantedPort =
    settings?.callbackPort ?? portOf((reusable as { redirect_uris?: unknown } | undefined)?.redirect_uris) ?? 0;
  let cb: Callback;
  try {
    cb = await callbackServer(wantedPort);
  } catch (err) {
    if (settings?.callbackPort || wantedPort === 0) {
      throw new OAuthFlowError(
        `cannot listen on 127.0.0.1:${wantedPort} for the browser's answer: ${(err as Error).message}`,
      );
    }
    cb = await callbackServer(0);
  }
  try {
    let client: OAuthClientInformationMixed;
    if (registration === "pre-registered") {
      client = { client_id: settings!.clientId! };
    } else if (registration === "metadata-document") {
      client = { client_id: settings!.clientMetadataUrl! };
    } else if (reusable && portOf((reusable as { redirect_uris?: unknown }).redirect_uris) === cb.port) {
      client = reusable;
    } else {
      try {
        client = await registerClient(d.issuer, {
          metadata: d.metadata,
          clientMetadata: clientMetadata(cb.redirectUri, scope),
          ...(scope ? { scope } : {}),
          fetchFn,
        });
      } catch (err) {
        throw new OAuthFlowError(
          `dynamic client registration at ${d.issuer} failed: ${scrub((err as Error).message, [])}`,
        );
      }
    }
    const presented = await clientFor({ registration, client } as OAuthRecord, settings, o.resolve);
    const state = randomBytes(32).toString("base64url");
    const { authorizationUrl, codeVerifier } = await startAuthorization(d.issuer, {
      metadata: d.metadata,
      clientInformation: presented,
      redirectUrl: cb.redirectUri,
      ...(scope ? { scope } : {}),
      state,
      resource: d.resource,
    });
    await o.open(authorizationUrl.href);
    const q = await cb.wait(o.timeoutMs ?? 5 * 60_000);
    // The issuer check comes first: on a mismatch nothing in the response is acted on or shown.
    checkIssuerParam(q, d.issuer, d.metadata);
    if (q.get("state") !== state)
      throw new OAuthFlowError("the authorization response has a different state; refusing it");
    const error = q.get("error");
    if (error)
      throw new OAuthFlowError(
        `the authorization server answered ${error}${q.get("error_description") ? `: ${scrub(q.get("error_description")!, [])}` : ""}`,
      );
    const code = q.get("code");
    if (!code) throw new OAuthFlowError("the authorization response has no code");
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorization(d.issuer, {
        metadata: d.metadata,
        clientInformation: presented,
        authorizationCode: code,
        codeVerifier,
        redirectUri: cb.redirectUri,
        resource: d.resource,
        fetchFn,
      });
    } catch (err) {
      throw new OAuthFlowError(
        `the token request failed: ${scrub((err as Error).message, [code, codeVerifier, presented.client_secret])}`,
      );
    }
    const at = now();
    const rec: OAuthRecord = {
      v: 1,
      issuer: d.issuer,
      resource: d.resource,
      ...(scope ? { scope } : {}),
      registration,
      client: registration === "pre-registered" ? { client_id: client.client_id } : client,
      tokens: toStored(tokens, at),
      savedAt: at,
    };
    await o.store.set(service, JSON.stringify(rec));
    return {
      issuer: d.issuer,
      registration,
      ...(scope ? { scope } : {}),
      redirectUri: cb.redirectUri,
      ...(rec.tokens?.expires_at ? { expiresAt: rec.tokens.expires_at } : {}),
      refreshToken: Boolean(rec.tokens?.refresh_token),
      service,
    };
  } finally {
    await cb.close();
  }
}

/**
 * Best-effort RFC 7009 revocation of a record's refresh token (else its access token).
 * Returns why it did not revoke, or undefined when the server accepted it.
 */
export async function revoke(
  server: RemoteServer,
  rec: OAuthRecord,
  resolve: SecretResolver,
  fetchFn: FetchLike = fetch,
): Promise<string | undefined> {
  const token = rec.tokens?.refresh_token ?? rec.tokens?.access_token;
  if (!token) return "no token to revoke";
  try {
    const metadata = await authorizationServerMetadata(rec.issuer, fetchFn);
    const endpoint = revocationEndpoint(metadata);
    if (!endpoint) return "the authorization server has no revocation endpoint";
    const client = await clientFor(rec, server.oauth, resolve);
    const body = new URLSearchParams({
      token,
      token_type_hint: rec.tokens?.refresh_token ? "refresh_token" : "access_token",
      client_id: client.client_id,
    });
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (client.client_secret)
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? undefined : `the revocation endpoint answered HTTP ${res.status}`;
  } catch (err) {
    return scrub((err as Error).message, [token]);
  }
}

// mcpd side ------------------------------------------------------------------------------------

export interface SessionOptions {
  /** The secret store; undefined when the machine has none. */
  store: () => SecretStore | undefined;
  resolve: SecretResolver;
  fetchFn?: FetchLike;
  now?: () => number;
  /** Diagnostics without secrets (mcpd writes them to the server's log). */
  log?: (line: string) => void;
  /** How long a login read from the store is trusted before it is read again (default 60 s). */
  recheckMs?: number;
}

/** A fingerprint of a stored value, so mcpd can tell whether someone else changed the item. */
function fp(raw: string | undefined): string {
  return raw === undefined ? "-" : createHash("sha256").update(raw).digest("hex");
}

/**
 * The login of one server variant inside mcpd: hands out a valid access token, refreshes it
 * when it expires or the server answers 401, and writes a rotated refresh token to the secret
 * store before the new access token is used. When that write fails, the new tokens stay in
 * memory (the old refresh token is already spent) and the write is retried on every later use;
 * a login or logout made meanwhile with `turno mcp login/logout` wins over them.
 */
export class OAuthSession {
  private rec?: OAuthRecord;
  /** Fingerprint of what the store held when mcpd last read or wrote it. */
  private seen?: string;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private unpersisted = false;
  private discovery?: Discovery;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    readonly name: string,
    readonly variant: string,
    private readonly opts: SessionOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  get service(): string {
    return oauthService(this.name, this.variant);
  }

  /** True while rotated tokens exist only in memory. */
  get pendingWrite(): boolean {
    return this.unpersisted;
  }

  /**
   * `turno mcp logout` (or login) changed the item: stop trusting the copy in memory, so the
   * next request reads the store at once instead of up to a minute later.
   */
  forget(): void {
    this.checkedAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * mcpd is stopping: one last try to save rotated tokens that exist only in memory (a login
   * or logout made meanwhile still wins). Returns true when they could not be saved and are
   * lost with this process.
   */
  flush(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.unpersisted || !this.rec) return false;
      try {
        await this.load(true);
      } catch {
        /* the store cannot be read: the tokens stay unsaved */
      }
      if (!this.unpersisted) return false;
      this.opts.log?.(
        `${this.label}: mcpd stopped before the secret store accepted the rotated OAuth tokens; the next refresh needs a new login`,
      );
      return true;
    });
  }

  private get label(): string {
    return `${this.name}${this.variant === "default" ? "" : `@${this.variant}`}`;
  }

  /** Run one at a time: two calls that see an expired token must not both spend the refresh token. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private requireStore(): SecretStore {
    const store = this.opts.store();
    if (!store)
      throw new LoginRequiredError(this.name, this.variant, "this machine has no secret store to keep the login in");
    return store;
  }

  /** The current record: memory while it is fresh, else the store (which wins when someone else changed it). */
  private async load(force = false): Promise<OAuthRecord | undefined> {
    const now = this.now();
    if (!force && !this.unpersisted && this.rec && now - this.checkedAt < (this.opts.recheckMs ?? RECHECK_MS))
      return this.rec;
    const store = this.requireStore();
    let raw: string | undefined;
    try {
      raw = await store.get(this.service);
    } catch (err) {
      if (this.rec) return this.rec;
      throw new LoginRequiredError(
        this.name,
        this.variant,
        `cannot read ${this.service} from the ${store.label}: ${(err as Error).message}`,
      );
    }
    this.checkedAt = now;
    const f = fp(raw);
    if (this.unpersisted && this.rec) {
      if (f === this.seen) {
        // Nobody touched the item since our write failed: try again to save the rotated tokens.
        await this.persist(this.rec);
        return this.rec;
      }
      this.opts.log?.(`${this.label}: a new login or logout replaced the OAuth tokens that were waiting to be saved`);
      this.unpersisted = false;
    }
    if (f !== this.seen) {
      this.rec = parseRecord(raw);
      this.seen = f;
    }
    return this.rec;
  }

  /** Memory first, then the store; a failed write leaves the record pending instead of losing it. */
  private async persist(next: OAuthRecord): Promise<void> {
    this.rec = next;
    this.checkedAt = this.now();
    const raw = JSON.stringify(next);
    try {
      await this.requireStore().set(this.service, raw);
      this.seen = fp(raw);
      if (this.unpersisted)
        this.opts.log?.(`${this.label}: saved the rotated OAuth tokens that were waiting in memory`);
      this.unpersisted = false;
    } catch (err) {
      if (!this.unpersisted) {
        this.opts.log?.(
          `${this.label}: could not save the rotated OAuth tokens to the secret store (${scrub((err as Error).message, [next.tokens?.access_token, next.tokens?.refresh_token])}); keeping them in memory and trying again on the next call`,
        );
      }
      this.unpersisted = true;
    }
  }

  private usable(t: StoredTokens | undefined): t is StoredTokens {
    return t !== undefined && (t.expires_at === undefined || t.expires_at - EXPIRY_SKEW_MS > this.now());
  }

  private checkBinding(server: RemoteServer, rec: OAuthRecord): void {
    if (
      !checkResourceAllowed({
        requestedResource: resourceUrlFromServerUrl(server.url),
        configuredResource: rec.resource,
      })
    ) {
      throw new LoginRequiredError(
        this.name,
        this.variant,
        `the login is for ${rec.resource}, and mcp.toml now says ${server.url}`,
      );
    }
    const id = server.oauth?.clientId;
    if (rec.registration === "pre-registered" ? id !== rec.client.client_id : id !== undefined) {
      throw new LoginRequiredError(this.name, this.variant, "client_id in mcp.toml changed since the login");
    }
  }

  /** A valid access token for a request, refreshing first when it expired. */
  accessToken(server: RemoteServer): Promise<string> {
    return this.serial(async () => {
      let rec = await this.load();
      // Without usable tokens, look again at once: `turno mcp login` may have just written them.
      if (!rec?.tokens) rec = await this.load(true);
      if (!rec) throw new LoginRequiredError(this.name, this.variant, "not logged in");
      this.checkBinding(server, rec);
      if (!rec.tokens)
        throw new LoginRequiredError(
          this.name,
          this.variant,
          "the authorization server rejected the last refresh token",
        );
      if (this.usable(rec.tokens)) return rec.tokens.access_token;
      return (await this.refresh(server, rec)).access_token;
    });
  }

  /** The server answered 401 to `stale`: refresh unless someone already replaced it. */
  afterUnauthorized(server: RemoteServer, stale: string): Promise<string> {
    return this.serial(async () => {
      const rec = await this.load(true);
      if (!rec?.tokens)
        throw new LoginRequiredError(
          this.name,
          this.variant,
          rec ? "the authorization server rejected the last refresh token" : "not logged in",
        );
      this.checkBinding(server, rec);
      if (rec.tokens.access_token !== stale && this.usable(rec.tokens)) return rec.tokens.access_token;
      return (await this.refresh(server, rec)).access_token;
    });
  }

  private async refresh(server: RemoteServer, rec: OAuthRecord, retried = false): Promise<StoredTokens> {
    const tokens = rec.tokens!;
    const refreshToken = tokens.refresh_token;
    if (!refreshToken)
      throw new LoginRequiredError(
        this.name,
        this.variant,
        "the access token expired and the server gave no refresh token",
      );
    const fetchFn = this.opts.fetchFn ?? fetch;
    let d: Discovery;
    try {
      d = this.discovery ?? (await discover(server, fetchFn));
    } catch (err) {
      throw new Error(`${this.label}: cannot refresh the OAuth token: ${(err as Error).message}`);
    }
    if (!sameIssuer(d.issuer, rec.issuer)) {
      // Spec: credentials are bound to the authorization server that issued them.
      this.discovery = undefined;
      throw new LoginRequiredError(this.name, this.variant, `the server now uses the authorization server ${d.issuer}`);
    }
    this.discovery = d;
    let fresh: OAuthTokens;
    try {
      fresh = await refreshAuthorization(rec.issuer, {
        metadata: d.metadata,
        clientInformation: await clientFor(rec, server.oauth, this.opts.resolve),
        refreshToken,
        resource: rec.resource,
        fetchFn,
      });
    } catch (err) {
      if (
        err instanceof InvalidGrantError ||
        err instanceof InvalidClientError ||
        err instanceof UnauthorizedClientError
      ) {
        // A login in another process may have replaced the token we hold: read the store again once.
        const latest = retried ? undefined : await this.load(true);
        if (latest?.tokens?.refresh_token && latest.tokens.refresh_token !== refreshToken) {
          return this.usable(latest.tokens) ? latest.tokens : this.refresh(server, latest, true);
        }
        const { tokens: _dropped, ...rest } = rec;
        await this.persist({ ...rest, savedAt: this.now() });
        this.opts.log?.(
          `${this.label}: the authorization server rejected the refresh token (${(err as Error).name}); a new login is needed`,
        );
        throw new LoginRequiredError(
          this.name,
          this.variant,
          "the authorization server rejected the refresh token (revoked or expired)",
        );
      }
      // Network trouble or a server error: keep the refresh token for the next try.
      this.discovery = undefined;
      throw new Error(
        `${this.label}: cannot refresh the OAuth token: ${scrub((err as Error).message, [refreshToken, tokens.access_token])}`,
      );
    }
    const next: OAuthRecord = { ...rec, tokens: toStored(fresh, this.now()), savedAt: this.now() };
    // Persist before the new access token is used: with rotation, the old refresh token is spent.
    await this.persist(next);
    this.opts.log?.(
      `${this.label}: refreshed the OAuth access token${next.tokens!.refresh_token !== refreshToken ? " (refresh token rotated)" : ""}`,
    );
    return next.tokens!;
  }
}

/** One session per server variant, shared by every instance and profile that uses it. */
export class OAuthSessions {
  private sessions = new Map<string, OAuthSession>();

  constructor(private readonly opts: SessionOptions | ((name: string, variant: string) => SessionOptions)) {}

  get(name: string, variant: string): OAuthSession {
    const key = `${name}@${variant}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = new OAuthSession(name, variant, typeof this.opts === "function" ? this.opts(name, variant) : this.opts);
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Forget what memory holds for these variants of a server (every variant when none are named). */
  forget(name: string, variants?: string[]): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.name !== name || (variants && !variants.includes(s.variant))) continue;
      s.forget();
      n++;
    }
    return n;
  }

  /** Save what is still only in memory; the labels whose tokens could not be saved. */
  async flush(): Promise<string[]> {
    const lost: string[] = [];
    for (const s of this.sessions.values()) {
      if (await s.flush().catch(() => true)) lost.push(s.variant === "default" ? s.name : `${s.name}@${s.variant}`);
    }
    return lost;
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * The fetch an OAuth server's transport uses: adds the access token to requests for the
 * server's own origin (never anywhere else), and on a 401 refreshes once and retries.
 */
export function oauthFetch(session: OAuthSession, server: () => RemoteServer, base: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const def = server();
    if (new URL(String(url)).origin !== new URL(def.url).origin) return base(url, init);
    const token = await session.accessToken(def);
    const res = await base(url, withBearer(init, token));
    if (res.status === 403) {
      const p = extractWWWAuthenticateParams(res);
      if (p.error === "insufficient_scope") {
        await res.body?.cancel().catch(() => {});
        const who = session.variant === "default" ? "" : ` --profile ${session.variant}`;
        throw new Error(
          `${def.name} needs more scopes${p.scope ? ` (${p.scope})` : ""}: run turno mcp login ${def.name}${who}${p.scope ? ` --scope "${p.scope}"` : ""}`,
        );
      }
      return res;
    }
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    const again = await session.afterUnauthorized(def, token);
    const retry = await base(url, withBearer(init, again));
    if (retry.status === 401) {
      await retry.body?.cancel().catch(() => {});
      throw new LoginRequiredError(session.name, session.variant, "the server rejected a freshly refreshed token");
    }
    return retry;
  };
}

/** What `mcp list` and `mcp doctor` show for a variant, read from the store only. */
export type LoginState = "logged in" | "expired" | "login required" | "not logged in" | "unknown";

export async function loginState(
  store: SecretStore | undefined,
  name: string,
  variant: string,
  now = Date.now(),
): Promise<{ state: LoginState; expiresAt?: number; refresh?: boolean }> {
  if (!store) return { state: "unknown" };
  let raw: string | undefined;
  try {
    raw = await store.get(oauthService(name, variant));
  } catch {
    return { state: "unknown" };
  }
  const rec = parseRecord(raw);
  if (!rec) return { state: "not logged in" };
  if (!rec.tokens) return { state: "login required" };
  const t = rec.tokens;
  const expired = t.expires_at !== undefined && t.expires_at <= now;
  if (expired && !t.refresh_token) return { state: "login required" };
  return {
    state: expired ? "expired" : "logged in",
    ...(t.expires_at ? { expiresAt: t.expires_at } : {}),
    refresh: Boolean(t.refresh_token),
  };
}
