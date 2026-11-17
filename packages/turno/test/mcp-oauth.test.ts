import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as mcp } from "../src/cli/commands/mcp.js";
import { type RemoteServer, parseManifest } from "../src/core/manifest.js";
import { paths } from "../src/core/paths.js";
import { keychainResolver, secretStore } from "../src/core/secrets.js";
import { DescriptionCache } from "../src/mcpd/cache.js";
import { DefaultConnector } from "../src/mcpd/connectors.js";
import { Gateway } from "../src/mcpd/gateway.js";
import { InstanceManager } from "../src/mcpd/instances.js";
import { type OAuthRecord, OAuthSession, type SessionOptions, checkIssuerParam, oauthService, parseRecord } from "../src/mcpd/oauth.js";
import { profileToken } from "../src/mcpd/tokens.js";
import { fakeIo } from "./helpers/cli.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type AuthServerOptions, type FakeAuthServer, type FakeResourceServer, approve, fakeAuthServer, fakeResourceServer } from "./helpers/oauth-fakes.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";

const TOKEN = "test-token";

let sb: Sandbox;
let keys: FakeSecretStore;
let as: FakeAuthServer;
let rs: FakeResourceServer;
let gw: Gateway | undefined;
let manager: InstanceManager | undefined;
let clients: Client[] = [];
let oauthLog: string[] = [];

async function setup(o: AuthServerOptions = {}, extraToml = ""): Promise<void> {
  as = await fakeAuthServer(o);
  rs = await fakeResourceServer(as);
  writeToml(`[server.rem]\nurl = ${JSON.stringify(rs.url)}\nauth = "oauth"\n${extraToml}`);
}

function writeToml(text: string): void {
  const file = paths(sb.env).mcpFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const toml = () => readFileSync(paths(sb.env).mcpFile, "utf8");
const record = (variant = "default"): OAuthRecord | undefined => parseRecord(keys.read(oauthService("rem", variant)));
const server = (): RemoteServer => parseManifest(toml()).servers.rem as RemoteServer;

/** `turno mcp login`, with the test playing the browser on the printed link. */
async function cliLogin(...args: string[]): Promise<{ code: number; lines: string[] }> {
  const io = fakeIo(sb.env);
  const run = mcp.run(["login", "rem", "--no-browser", ...args], io);
  const failed = run.then(
    () => undefined,
    (err: Error) => err,
  );
  const url = await waitFor<string | undefined>(
    async () => io.lines.find((l) => l.includes("/authorize?")) ?? ((await Promise.race([failed, Promise.resolve("pending")])) !== "pending" ? "failed" : undefined),
    "the authorization link",
  );
  if (url === undefined) throw new Error("no authorization link");
  if (url === "failed") throw await failed;
  await approve(url);
  return { code: await run, lines: [...io.lines, ...io.errors] };
}

function sessionOpts(extra: Partial<SessionOptions> = {}): SessionOptions {
  return { store: () => secretStore(sb.env), resolve: keychainResolver(sb.env), log: (l) => oauthLog.push(l), ...extra };
}

/** mcpd with the current mcp.toml; a new call stands for a restarted daemon (no memory). */
async function boot(): Promise<number> {
  await stopGateway();
  const manifest = parseManifest(toml());
  manager = new InstanceManager({
    cache: new DescriptionCache(join(sb.home, "cache")),
    connector: new DefaultConnector({
      resolve: keychainResolver(sb.env),
      serversDir: join(sb.home, "servers"),
      logsDir: join(sb.home, "logs"),
      // The default sessions: the secret store on the PATH of `vars`, logs in logs/<server>.log.
      vars: sb.env,
    }),
    home: sb.home,
  });
  gw = new Gateway({ manager, manifest: () => manifest, token: TOKEN, clientRequestTimeoutMs: 5000, processCwd: async () => undefined });
  return gw.listen(0);
}

async function stopGateway(): Promise<void> {
  for (const c of clients) await c.close().catch(() => {});
  clients = [];
  await manager?.stopAll();
  await gw?.close();
  gw = undefined;
  manager = undefined;
}

async function agent(port: number, profile = "default"): Promise<Client> {
  const client = new Client({ name: "agent", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/rem`), {
      requestInit: { headers: { Authorization: `Bearer ${profileToken(TOKEN, profile)}`, "X-Turno-Profile": profile } },
    }),
  );
  clients.push(client);
  return client;
}

async function whoami(c: Client): Promise<string> {
  const r = (await c.callTool({ name: "whoami", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  if (r.isError) throw new Error(r.content[0]?.text);
  return r.content[0]?.text ?? "";
}

beforeEach(() => {
  sb = sandbox();
  keys = fakeSecretStore(sb);
  oauthLog = [];
});

afterEach(async () => {
  await stopGateway();
  await rs?.close();
  await as?.close();
  sb.cleanup();
});

describe("mcp.toml: auth = \"oauth\" (ADR 0029)", () => {
  it("proxies the server through mcpd and keeps auth keys out of the agent entry", () => {
    const m = parseManifest(
      `[server.lin]\nurl = "https://mcp.example.com/mcp"\nauth = "oauth"\n[server.lin.oauth]\nscope = "read"\ncallback_port = 33418\n[server.lin.variant.work]\n`,
    );
    const s = m.servers.lin as RemoteServer;
    expect(s.proxy).toBe(true);
    expect(s.oauth).toEqual({ scope: "read", callbackPort: 33418 });
    expect(Object.keys(s.variants)).toEqual(["work"]);
    expect(s.entry).toEqual({ type: "http", url: "https://mcp.example.com/mcp" });
  });

  it("rejects settings that cannot work", () => {
    const bad = (body: string) => () => parseManifest(`[server.lin]\nurl = "https://mcp.example.com/mcp"\n${body}`);
    expect(bad(`auth = "basic"`)).toThrow(/auth must be "oauth"/);
    expect(bad(`[server.lin.oauth]\nscope = "x"`)).toThrow(/needs auth = "oauth"/);
    expect(bad(`auth = "oauth"\nheaders = { Authorization = "keychain:x" }`)).toThrow(/remove headers.Authorization/);
    expect(bad(`auth = "oauth"\n[server.lin.oauth]\nclient = "x"`)).toThrow(/not an OAuth setting/);
    expect(bad(`auth = "oauth"\n[server.lin.oauth]\ncallback_port = 80`)).toThrow(/callback_port/);
    expect(bad(`[server.lin.variant.work]`)).toThrow(/variants only with auth = "oauth"/);
    expect(bad(`auth = "oauth"\n[server.lin.oauth]\nclient_secret = "plain-secret"`)).toThrow(/keychain: or env: reference/);
  });

  it("the fake secret store answers as the Secret Service too (Linux CI)", async () => {
    const store = secretStore(sb.env, "linux")!;
    await store.set("turno/oauth/x@default", '{"a":"b c"}');
    expect(await store.get("turno/oauth/x@default")).toBe('{"a":"b c"}');
    expect(keys.services()).toEqual(["turno/oauth/x@default"]);
    expect(await store.remove("turno/oauth/x@default")).toBe(true);
    expect(await store.get("turno/oauth/x@default")).toBeUndefined();
  });
});

describe("turno mcp login", () => {
  it("discovers, registers, runs PKCE on a loopback redirect and stores the tokens in the secret store", async () => {
    await setup();
    const { code, lines } = await cliLogin();
    expect(code).toBe(0);
    const rec = record()!;
    expect(rec.issuer).toBe(as.issuer);
    expect(rec.resource).toBe(rs.url);
    expect(rec.registration).toBe("dynamic");
    expect(rec.tokens?.refresh_token).toBeTruthy();
    // Registration as a native app with a 127.0.0.1 redirect, asking for refresh tokens.
    const reg = as.registrations[0]!;
    expect(reg.application_type).toBe("native");
    expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(String((reg.redirect_uris as string[])[0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // PKCE S256, the resource indicator, state, and the challenge scope plus offline_access.
    const q = as.authorizeRequests[0]!;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(rs.url);
    expect(q.get("state")?.length).toBeGreaterThan(20);
    expect(q.get("scope")).toBe("mcp:read offline_access");
    expect(as.tokenRequests[0]!.get("resource")).toBe(rs.url);
    // No token in the output, and nothing about the login on disk outside the store.
    const out = lines.join("\n");
    expect(out).toContain(`as turno/oauth/rem@default`);
    expect(out).not.toContain(rec.tokens!.access_token);
    expect(out).not.toContain(rec.tokens!.refresh_token!);
  });

  it("refuses an authorization server that does not advertise PKCE", async () => {
    await setup({ pkce: false });
    await expect(mcp.run(["login", "rem", "--no-browser"], fakeIo(sb.env))).rejects.toThrow(/does not advertise PKCE with S256/);
    expect(keys.services()).toEqual([]);
  });

  it("refuses metadata whose issuer is not the one it was fetched for (RFC 8414)", async () => {
    await setup({ issuerInMetadata: "https://honest.example" });
    await expect(mcp.run(["login", "rem", "--no-browser"], fakeIo(sb.env))).rejects.toThrow(/RFC 8414 section 3.3/);
  });

  it("refuses an authorization response from another issuer (RFC 9207) or with another state", async () => {
    await setup({ iss: "wrong" });
    await expect(cliLogin()).rejects.toThrow(/RFC 9207/);
    as.options.iss = "missing";
    await expect(cliLogin()).rejects.toThrow(/has no iss although/);
    as.options.iss = "right";
    as.options.state = "forged";
    await expect(cliLogin()).rejects.toThrow(/different state/);
    expect(keys.services()).toEqual([]);
  });

  it("checks iss by simple string comparison, and accepts a missing one only when not advertised", () => {
    const meta = { issuer: "https://as.example", authorization_response_iss_parameter_supported: false } as never;
    expect(() => checkIssuerParam(new URLSearchParams(""), "https://as.example", meta)).not.toThrow();
    expect(() => checkIssuerParam(new URLSearchParams("iss=https://AS.example"), "https://as.example", meta)).toThrow(/RFC 9207/);
  });

  it("asks for a client_id when the server offers no way to register", async () => {
    await setup({ dcr: false });
    await expect(mcp.run(["login", "rem", "--no-browser"], fakeIo(sb.env))).rejects.toThrow(/set client_id under \[server.rem.oauth\]/);
  });

  it("uses a pre-registered client on its fixed callback port", async () => {
    as = await fakeAuthServer();
    rs = await fakeResourceServer(as);
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const reg = await fetch(`${as.issuer}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:${port}/callback`] }) });
    const { client_id } = (await reg.json()) as { client_id: string };
    as.registrations = [];
    writeToml(`[server.rem]\nurl = ${JSON.stringify(rs.url)}\nauth = "oauth"\n[server.rem.oauth]\nclient_id = "${client_id}"\ncallback_port = ${port}\n`);
    await cliLogin();
    expect(as.registrations).toEqual([]);
    expect(record()!.registration).toBe("pre-registered");
    expect(record()!.client).toEqual({ client_id });
  });

  it("plans with --dry-run without a browser or a write", async () => {
    await setup();
    const io = fakeIo(sb.env);
    expect(await mcp.run(["login", "rem", "--dry-run"], io)).toBe(0);
    expect(io.lines.join("\n")).toMatch(/would log in to rem .*\n {2}client: dynamic client registration\n {2}scope: mcp:read offline_access/);
    expect(as.registrations).toEqual([]);
    expect(keys.services()).toEqual([]);
  });
});

describe("mcpd as the OAuth client", () => {
  it("serves every profile through one login, with the server's own token", async () => {
    await setup();
    await cliLogin();
    const port = await boot();
    expect(await whoami(await agent(port, "default"))).toBe("alice");
    expect(await whoami(await agent(port, "work"))).toBe("alice");
    const at = record()!.tokens!.access_token;
    expect(rs.seen.filter((h) => h).every((h) => h === `Bearer ${at}`)).toBe(true);
    expect(rs.seen.some((h) => h.includes(profileToken(TOKEN, "work")))).toBe(false);
  });

  it("keeps one login per variant: a profile with a variant has its own account", async () => {
    await setup({}, `[server.rem.variant.work]\n`);
    await cliLogin();
    as.account = "bob";
    await cliLogin("--profile", "work");
    expect(keys.services().sort()).toEqual(["turno/oauth/rem@default", "turno/oauth/rem@work"]);
    const port = await boot();
    expect(await whoami(await agent(port, "personal"))).toBe("alice");
    expect(await whoami(await agent(port, "work"))).toBe("bob");
  });

  it("answers with the login command when there is no login, and works right after it", async () => {
    await setup();
    const port = await boot();
    const a = await agent(port).catch((e: Error) => e);
    expect(String(a)).toMatch(/rem needs a login \(not logged in\): run turno mcp login rem/);
    await cliLogin();
    expect(await whoami(await agent(port))).toBe("alice");
  });

  it("refreshes on 401, rotates the refresh token and writes it to the store before using it", async () => {
    await setup();
    await cliLogin();
    const before = record()!.tokens!;
    const port = await boot();
    const a = await agent(port);
    expect(await whoami(a)).toBe("alice");
    as.expireAccessTokens();
    expect(await whoami(a)).toBe("alice");
    expect(as.refreshes).toBe(1);
    const after = record()!.tokens!;
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(as.refreshValid(before.refresh_token!)).toBe(false);
    expect(as.refreshValid(after.refresh_token!)).toBe(true);
    // A restarted mcpd starts from the store and refreshes with the rotated token.
    as.expireAccessTokens();
    const port2 = await boot();
    expect(await whoami(await agent(port2))).toBe("alice");
    expect(as.refreshes).toBe(2);
  });

  it("refreshes an access token that expired by the clock, once for concurrent callers", async () => {
    await setup();
    await cliLogin();
    let now = Date.now();
    const s = new OAuthSession("rem", "default", sessionOpts({ now: () => now }));
    const first = await s.accessToken(server());
    now += 2 * 3600 * 1000;
    const [x, y] = await Promise.all([s.accessToken(server()), s.accessToken(server())]);
    expect(x).toBe(y);
    expect(x).not.toBe(first);
    expect(as.refreshes).toBe(1);
  });

  it("asks for a new login when the refresh token was revoked, and says so in mcp list", async () => {
    await setup();
    await cliLogin();
    const port = await boot();
    const a = await agent(port);
    expect(await whoami(a)).toBe("alice");
    as.revokeRefreshTokens();
    as.expireAccessTokens();
    await expect(whoami(a)).rejects.toThrow(/rem needs a login \(the authorization server rejected the refresh token.*\): run turno mcp login rem/);
    expect(record()!.tokens).toBeUndefined();
    expect(record()!.client.client_id).toBeTruthy();
    const io = fakeIo(sb.env);
    await mcp.run(["list"], io);
    expect(io.lines.join("\n")).toMatch(/remote via mcpd, oauth .*login: login required: turno mcp login rem/);
    const doc = fakeIo(sb.env);
    expect(await mcp.run(["doctor"], doc)).toBe(1);
    expect(doc.lines.join("\n")).toContain("rem: login required: turno mcp login rem");
    // The same registration is reused, and the running mcpd picks the new login up.
    await cliLogin();
    expect(as.registrations).toHaveLength(1);
    expect(await whoami(a)).toBe("alice");
  });

  it("keeps a rotated refresh token in memory when the store refuses it, and saves it later", async () => {
    await setup();
    await cliLogin();
    const stale = record()!.tokens!.refresh_token!;
    const port = await boot();
    const a = await agent(port);
    expect(await whoami(a)).toBe("alice");
    keys.failWrites(true);
    as.expireAccessTokens();
    expect(await whoami(a)).toBe("alice");
    expect(record()!.tokens!.refresh_token).toBe(stale);
    expect(as.refreshValid(stale)).toBe(false);
    // Still refused: the next refresh uses the rotated token from memory, not the spent one.
    as.expireAccessTokens();
    expect(await whoami(a)).toBe("alice");
    expect(as.refreshes).toBe(2);
    keys.failWrites(false);
    as.expireAccessTokens();
    expect(await whoami(a)).toBe("alice");
    const saved = record()!.tokens!;
    expect(as.refreshValid(saved.refresh_token!)).toBe(true);
    // Nothing was lost: a restarted mcpd refreshes with what the store holds now.
    as.expireAccessTokens();
    const port2 = await boot();
    expect(await whoami(await agent(port2))).toBe("alice");
    const log = readFileSync(join(sb.home, "logs", "rem.log"), "utf8");
    expect(log).toContain("could not save the rotated OAuth tokens");
    expect(log).toContain("saved the rotated OAuth tokens that were waiting in memory");
    for (const t of [stale, saved.refresh_token!, saved.access_token]) expect(log).not.toContain(t);
  });

  it("lets a new login win over tokens still waiting to be saved", async () => {
    await setup();
    await cliLogin();
    const s = new OAuthSession("rem", "default", sessionOpts({ recheckMs: 0 }));
    const first = await s.accessToken(server());
    keys.failWrites(true);
    await s.afterUnauthorized(server(), first);
    expect(s.pendingWrite).toBe(true);
    keys.failWrites(false);
    as.account = "carol";
    await cliLogin();
    const fresh = record()!.tokens!.access_token;
    expect(await s.accessToken(server())).toBe(fresh);
    expect(s.pendingWrite).toBe(false);
    expect(oauthLog.join("\n")).toContain("a new login or logout replaced the OAuth tokens");
  });
});

describe("turno mcp logout and status", () => {
  it("lists the login, then revokes the token and removes the item", async () => {
    await setup();
    await cliLogin();
    const list = fakeIo(sb.env);
    await mcp.run(["list", "--json"], list);
    expect(JSON.parse(list.lines.join("\n"))[0]).toMatchObject({ name: "rem", auth: "oauth", logins: { default: "logged in" } });
    const refresh = record()!.tokens!.refresh_token!;
    const io = fakeIo(sb.env);
    expect(await mcp.run(["logout", "rem"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain(`removed turno/oauth/rem@default from the`);
    expect(io.lines.join("\n")).toContain(`revoked it at ${as.issuer}`);
    expect(as.revoked).toEqual([refresh]);
    expect(keys.services()).toEqual([]);
    const after = fakeIo(sb.env);
    await mcp.run(["list"], after);
    expect(after.lines.join("\n")).toContain("login: not logged in: turno mcp login rem");
  });

  it("refuses servers without auth = \"oauth\" and profiles the server does not serve", async () => {
    writeToml(`[server.plain]\nurl = "https://mcp.example.com/mcp"\n[server.lin]\nurl = "https://mcp.example.com/x"\nauth = "oauth"\nprofiles = ["work"]\n`);
    await expect(mcp.run(["login", "plain"], fakeIo(sb.env))).rejects.toThrow(/not a remote server with auth = "oauth"/);
    await expect(mcp.run(["login", "lin", "--profile", "home"], fakeIo(sb.env))).rejects.toThrow(/not served to profile home/);
  });
});
