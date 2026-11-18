import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * An in-process OAuth 2.1 authorization server and an MCP resource server that it protects,
 * both on 127.0.0.1, for the tests of ADR 0029. The authorization server approves every
 * request at once as `account` (no user, no browser): `approve(url)` plays the browser.
 */

export interface AuthServerOptions {
  /** Advertise PKCE (code_challenge_methods_supported). Default true. */
  pkce?: boolean;
  /** Issuer written in the metadata document; defaults to the real one. */
  issuerInMetadata?: string;
  /** What to put in `iss` of the authorization response. Default "right". */
  iss?: "right" | "wrong" | "missing";
  /** Rotate refresh tokens on use. Default true. */
  rotate?: boolean;
  /** Seconds an access token lives. Default 3600. */
  accessTtl?: number;
  /** Offer dynamic client registration. Default true. */
  dcr?: boolean;
  /** Overwrite the state of the authorization response. */
  state?: string;
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | null;
  scope: string | null;
  sub: string;
}

interface Grant {
  sub: string;
  clientId: string;
  resource: string | null;
  scope: string | null;
}

export interface FakeAuthServer {
  issuer: string;
  options: AuthServerOptions;
  /** Who the next login is. */
  account: string;
  registrations: Record<string, unknown>[];
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  revoked: string[];
  /** Refresh grants that succeeded. */
  refreshes: number;
  /** The subject of an access token valid for `resource`, else undefined. */
  validate(token: string, resource: string): string | undefined;
  /** Every access token issued so far stops working (the resource server answers 401). */
  expireAccessTokens(): void;
  /** Every refresh token issued so far is revoked. */
  revokeRefreshTokens(): void;
  /** Whether a refresh token is still accepted. */
  refreshValid(token: string): boolean;
  close(): Promise<void>;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: HttpServer; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function close(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

const token = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

export async function fakeAuthServer(options: AuthServerOptions = {}): Promise<FakeAuthServer> {
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, Code>();
  const access = new Map<string, Grant & { expired: boolean; until: number }>();
  const refresh = new Map<string, Grant & { valid: boolean }>();
  const fake: FakeAuthServer = {
    issuer: "",
    options,
    account: "alice",
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    revoked: [],
    refreshes: 0,
    validate(t, resource) {
      const a = access.get(t);
      if (!a || a.expired || a.until < Date.now()) return undefined;
      if (a.resource !== resource) return undefined;
      return a.sub;
    },
    expireAccessTokens: () => access.forEach((a) => (a.expired = true)),
    revokeRefreshTokens: () => refresh.forEach((r) => (r.valid = false)),
    refreshValid: (t) => refresh.get(t)?.valid === true,
    close: async () => close(server),
  };
  const issue = (g: Grant) => {
    const at = token("at");
    const rt = token("rt");
    access.set(at, { ...g, expired: false, until: Date.now() + (options.accessTtl ?? 3600) * 1000 });
    refresh.set(rt, { ...g, valid: true });
    return {
      access_token: at,
      token_type: "Bearer",
      expires_in: options.accessTtl ?? 3600,
      refresh_token: rt,
      ...(g.scope ? { scope: g.scope } : {}),
    };
  };
  const { server, base } = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: options.issuerInMetadata ?? fake.issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(options.dcr === false ? {} : { registration_endpoint: `${base}/register` }),
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
        ...(options.pkce === false ? {} : { code_challenge_methods_supported: ["S256"] }),
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const meta = JSON.parse(await body(req)) as Record<string, unknown> & { redirect_uris: string[] };
      fake.registrations.push(meta);
      const id = token("client");
      clients.set(id, { redirect_uris: meta.redirect_uris });
      return json(res, 201, { ...meta, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      fake.authorizeRequests.push(q);
      const client = clients.get(q.get("client_id") ?? "");
      const redirect = q.get("redirect_uri") ?? "";
      if (!client || !client.redirect_uris.includes(redirect)) return json(res, 400, { error: "invalid_request" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
        return json(res, 400, { error: "invalid_request" });
      const code = token("code");
      codes.set(code, {
        clientId: q.get("client_id")!,
        redirectUri: redirect,
        challenge: q.get("code_challenge")!,
        resource: q.get("resource"),
        scope: q.get("scope"),
        sub: fake.account,
      });
      const to = new URL(redirect);
      to.searchParams.set("code", code);
      to.searchParams.set("state", options.state ?? q.get("state") ?? "");
      if (options.iss !== "missing")
        to.searchParams.set("iss", options.iss === "wrong" ? "https://evil.example" : fake.issuer);
      res.writeHead(302, { Location: to.href }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const q = new URLSearchParams(await body(req));
      fake.tokenRequests.push(q);
      if (q.get("grant_type") === "authorization_code") {
        const c = codes.get(q.get("code") ?? "");
        codes.delete(q.get("code") ?? "");
        const verifier = q.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !c ||
          c.clientId !== q.get("client_id") ||
          c.redirectUri !== q.get("redirect_uri") ||
          c.challenge !== challenge ||
          c.resource !== q.get("resource")
        ) {
          return json(res, 400, { error: "invalid_grant" });
        }
        return json(res, 200, issue({ sub: c.sub, clientId: c.clientId, resource: c.resource, scope: c.scope }));
      }
      if (q.get("grant_type") === "refresh_token") {
        const old = q.get("refresh_token") ?? "";
        const r = refresh.get(old);
        if (!r || !r.valid || r.clientId !== q.get("client_id"))
          return json(res, 400, { error: "invalid_grant", error_description: "refresh token is not valid" });
        fake.refreshes++;
        if (options.rotate === false) {
          const at = token("at");
          access.set(at, { ...r, expired: false, until: Date.now() + (options.accessTtl ?? 3600) * 1000 });
          return json(res, 200, { access_token: at, token_type: "Bearer", expires_in: options.accessTtl ?? 3600 });
        }
        r.valid = false;
        return json(res, 200, issue(r));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const q = new URLSearchParams(await body(req));
      const t = q.get("token") ?? "";
      fake.revoked.push(t);
      const r = refresh.get(t);
      if (r) r.valid = false;
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });
  fake.issuer = base;
  return fake;
}

export interface FakeResourceServer {
  url: string;
  /** Authorization headers seen on MCP requests. */
  seen: string[];
  close(): Promise<void>;
}

/**
 * An MCP server at `<base>/mcp` that accepts only access tokens of `as` issued for it, and
 * publishes RFC 9728 metadata. Its tool `whoami` answers the token's subject.
 */
export async function fakeResourceServer(as: FakeAuthServer, o: { scope?: string } = {}): Promise<FakeResourceServer> {
  const seen: string[] = [];
  let resource = "";
  let prm = "";
  const { server, base } = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, {
        resource,
        authorization_servers: [as.issuer],
        scopes_supported: ["mcp:read"],
        bearer_methods_supported: ["header"],
      });
    }
    if (url.pathname !== "/mcp") return void res.writeHead(404).end();
    const auth = String(req.headers.authorization ?? "");
    seen.push(auth);
    const sub = auth.startsWith("Bearer ") ? as.validate(auth.slice(7), resource) : undefined;
    if (!sub) {
      res
        .writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${prm}", scope="${o.scope ?? "mcp:read"}"` })
        .end();
      return;
    }
    // Stateless: a fresh server per request, with the caller's identity.
    const s = new Server({ name: "protected", version: "1" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "whoami", inputSchema: { type: "object" as const, properties: {} } }],
    }));
    s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text" as const, text: sub }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await s.connect(t);
    await t.handleRequest(req, res);
  });
  resource = `${base}/mcp`;
  prm = `${base}/.well-known/oauth-protected-resource/mcp`;
  return { url: resource, seen, close: () => close(server) };
}

/** Play the browser: follow the authorization URL to its redirect, and deliver it to the callback. */
export async function approve(authorizationUrl: string): Promise<void> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  const to = res.headers.get("location");
  if (res.status !== 302 || !to)
    throw new Error(`the authorization server refused: HTTP ${res.status} ${await res.text()}`);
  await (await fetch(to)).text();
}
