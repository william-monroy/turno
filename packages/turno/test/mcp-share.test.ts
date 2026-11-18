import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { main } from "../src/cli/main.js";
import { markOAuth, probeOAuth } from "../src/mcpd/importer.js";
import { exportManifest, mergeServers, removeServer } from "../src/mcpd/share.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const API_KEY = "sk-live-abcdef0123456789abcdef";

const MANIFEST = `# my servers
[server.gh]
command = "github-mcp"
package = "@acme/github-mcp@1.2.3"
env = { GITHUB_TOKEN = "${SECRET}", LOG_LEVEL = "info" }

[server.db]
command = "db-mcp"
args = ["--api-key", "${API_KEY}", "--readonly"]
env = { DB_TOKEN = "keychain:db-token", HOME_DIR = "env:HOME" }
profiles = ["work"]

[server.db.variant.home]
env = { DB_TOKEN = "keychain:db-home" }

[server.db.variant.work]
env = { EXTRA_SECRET = "${API_KEY}" }

[server.docs]
url = "https://docs.example.com/mcp?api_key=${API_KEY}"
`;

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
  sb.write(".config/turno/config.toml", '[profiles.work]\n[profiles.home]\n[profiles.cx]\nagent = "codex"\n');
});

afterEach(() => {
  sb.cleanup();
});

async function run(args: string[], env = sb.env) {
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

/** A server that answers like an MCP server behind OAuth, or like an open one. */
let oauthServer: Server;
let base = "";
beforeAll(async () => {
  oauthServer = createServer((req, res) => {
    if (req.url?.startsWith("/locked")) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    }
  });
  await new Promise<void>((r) => oauthServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`;
});
afterAll(() => {
  oauthServer.close();
});

describe("exportManifest", () => {
  it("names every secret and never prints a value", () => {
    const r = exportManifest(MANIFEST);
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toContain(API_KEY);
    const servers = parse(r.text).server as Record<string, Record<string, unknown>>;
    expect((servers.gh!.env as Record<string, string>).GITHUB_TOKEN).toBe("keychain:turno/gh/github-token");
    expect((servers.gh!.env as Record<string, string>).LOG_LEVEL).toBe("info");
    expect(servers.gh!.package).toBe("@acme/github-mcp@1.2.3");
    expect((servers.db!.env as Record<string, string>).DB_TOKEN).toBe("keychain:db-token");
    expect(servers.db!.args).toEqual(["--api-key", "<secret>", "--readonly"]);
    expect(servers.docs!.url).toBe("https://docs.example.com/mcp?api_key=<secret>");
    expect(r.keychain).toEqual(["db-home", "db-token", "turno/db/work/extra-secret", "turno/gh/github-token"]);
    expect(r.envVars).toEqual(["HOME"]);
    expect(r.redacted).toEqual(["db.args", "docs.url"]);
    expect(r.text).toMatch(/^# {3}turno secret set turno\/gh\/github-token$/m);
    expect(() => parseManifest(r.text)).not.toThrow();
  });

  it("--profile keeps that profile's servers and its own variant only", () => {
    const home = exportManifest(MANIFEST, { profile: "home" });
    expect(home.servers).toEqual(["gh", "docs"]);
    const work = exportManifest(MANIFEST, { profile: "work" });
    expect(work.servers).toEqual(["gh", "db", "docs"]);
    const db = (parse(work.text).server as Record<string, Record<string, unknown>>).db!;
    expect(Object.keys(db.variant as object)).toEqual(["work"]);
    expect(work.keychain).not.toContain("db-home");
  });
});

describe("mergeServers and removeServer", () => {
  const existing = "# keep me\n[server.a]\ncommand = \"a\"\n\n[server.b]\ncommand = \"b\"\nenv = { X = \"1\" }\n\n[server.b.variant.work]\nargs = [\"--w\"]\n";

  it("appends new servers, keeps existing ones, and keeps comments", () => {
    const r = mergeServers(existing, { b: { command: "b2" }, c: { command: "c" } }, false);
    expect(r).toMatchObject({ added: ["c"], replaced: [], kept: ["b"] });
    expect(r.text).toContain("# keep me");
    const s = parseManifest(r.text).servers;
    expect(Object.keys(s)).toEqual(["a", "b", "c"]);
    expect((s.b as { command: string }).command).toBe("b");
  });

  it("--force replaces a server with all its sub-tables", () => {
    const r = mergeServers(existing, { b: { command: "b2" } }, true);
    expect(r.replaced).toEqual(["b"]);
    const b = parseManifest(r.text).servers.b as { command: string; variants: object; env: object };
    expect(b.command).toBe("b2");
    expect(b.variants).toEqual({});
    expect(b.env).toEqual({});
  });

  it("refuses to replace a server that is not its own table", () => {
    expect(removeServer('[server]\nb = { command = "b" }\n', "b")).toBeUndefined();
    expect(() => mergeServers('[server]\nb = { command = "b" }\n', { b: { command: "x" } }, true)).toThrow(/edit it by hand/);
  });
});

describe("OAuth detection", () => {
  it("probeOAuth: a 401 with a Bearer challenge is OAuth, anything else is not", async () => {
    expect(await probeOAuth(`${base}/locked`)).toBe(true);
    expect(await probeOAuth(`${base}/open`)).toBe(false);
    expect(await probeOAuth("http://127.0.0.1:1/nothing", 500)).toBe(false);
    expect(await probeOAuth("file:///etc/passwd")).toBe(false);
  });

  it("markOAuth probes only remotes without auth of their own", async () => {
    const asked: string[] = [];
    const servers: Record<string, Record<string, unknown>> = {
      a: { url: "https://a.example/mcp" },
      b: { url: "https://b.example/mcp", headers: { Authorization: "Bearer x" } },
      c: { url: "https://c.example/mcp", auth: "oauth" },
      d: { url: "https://d.example/mcp", headers: { "X-Api-Key": "keychain:k" } },
      e: { command: "e" },
    };
    const notes: string[] = [];
    const marked = await markOAuth(
      servers,
      async (u) => {
        asked.push(u);
        return true;
      },
      notes,
    );
    expect(asked).toEqual(["https://a.example/mcp"]);
    expect(marked).toEqual(["a"]);
    expect(servers.a!.auth).toBe("oauth");
    expect(notes.join("\n")).toMatch(/turno mcp login a/);
  });
});

describe("turno mcp export and import <file>", () => {
  it("round-trips: export on one machine, import on another, without a secret value", async () => {
    sb.write(".config/turno/mcp.toml", MANIFEST);
    const ex = await run(["mcp", "export"]);
    expect(ex.code).toBe(0);
    expect(ex.out).not.toContain(SECRET);
    expect(ex.err).toMatch(/exported 3 servers, no secret values/);
    expect(ex.err).toMatch(/^Next: on the other machine/m);

    const other = sandbox();
    try {
      other.write(".config/turno/config.toml", "[profiles.work]\n");
      const file = other.write("servers.toml", `${ex.out}\n`);
      const io = fakeIo(other.env);
      const preview = await main(["mcp", "import", file], io);
      expect(preview).toBe(0);
      expect(io.lines.join("\n")).toMatch(/would add gh, db, docs/);
      const io2 = fakeIo(other.env);
      expect(await main(["mcp", "import", file, "--write"], io2)).toBe(0);
      const written = readFileSync(join(other.home, ".config/turno/mcp.toml"), "utf8");
      expect(written).toContain('GITHUB_TOKEN = "keychain:turno/gh/github-token"');
      const out = io2.lines.join("\n");
      expect(out).toMatch(/^added gh, db, docs$/m);
      expect(out).toMatch(/^Next: turno secret list shows which of 4 keychain references still need turno secret set; turno mcp install pins and installs the packages; turno mcp sync points your profiles at them$/m);
    } finally {
      other.cleanup();
    }
  });

  it("keeps servers already there unless --force, and marks OAuth remotes on --write", async () => {
    sb.write(".config/turno/mcp.toml", '[server.gh]\ncommand = "mine"\n');
    const file = sb.write("in.toml", `[server.gh]\ncommand = "theirs"\n\n[server.linear]\nurl = "${base}/locked/mcp"\n\n[server.open]\nurl = "${base}/open/mcp"\n`);
    const r = await run(["mcp", "import", file, "--write"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/kept gh \(already in mcp.toml; --force replaces them\)/);
    expect(r.out).toMatch(/turno mcp login linear/);
    const s = parseManifest(readFileSync(join(sb.home, ".config/turno/mcp.toml"), "utf8")).servers;
    expect((s.gh as { command: string }).command).toBe("mine");
    expect((s.linear as { oauth?: object }).oauth).toEqual({});
    expect((s.open as { oauth?: object }).oauth).toBeUndefined();
    expect((await run(["mcp", "import", file, "--write", "--force"])).out).toMatch(/^replaced gh, linear, open$/m);
  });

  it("takes an agent's JSON config too, skipping turno's own gateway entries", async () => {
    const file = sb.write(
      "claude.json",
      JSON.stringify({ mcpServers: { fs: { command: "fs-mcp", args: ["/tmp"] }, gw: { type: "http", url: "http://127.0.0.1:47821/mcp/gw", headers: { "X-Turno-Profile": "work" } } } }),
    );
    const r = await run(["mcp", "import", file]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("would add fs");
    expect(r.err).toMatch(/Claude Code config/);
  });

  it("refuses a file it does not understand, and a missing one", async () => {
    expect((await run(["mcp", "import", sb.write("x.txt", "hello")])).code).toBe(1);
    expect((await run(["mcp", "import", join(sb.home, "nope.toml")])).code).toBe(1);
  });

  it("hints = false turns the next steps off", async () => {
    sb.write(".config/turno/config.toml", "hints = false\n[profiles.work]\n");
    sb.write(".config/turno/mcp.toml", MANIFEST);
    expect((await run(["mcp", "export"])).err).not.toMatch(/Next:/);
    expect((await run(["config", "set", "hints", "maybe"])).code).toBe(2);
  });

  it("export --json has the text and the secret names", async () => {
    sb.write(".config/turno/mcp.toml", MANIFEST);
    const j = JSON.parse((await run(["mcp", "export", "--profile", "home", "--json"])).out);
    expect(j).toMatchObject({ schemaVersion: 1, profile: "home", servers: ["gh", "docs"], keychain: ["turno/gh/github-token"] });
    expect(j.text).not.toContain(SECRET);
  });
});
