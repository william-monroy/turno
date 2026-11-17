import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "../src/core/manifest.js";
import { definitionFingerprint } from "../src/mcpd/instances.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

export async function run(args: string[], env = sb.env) {
  const { main } = await import("../src/cli/main.js");
  const io = fakeIo(env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe("definition fingerprint", () => {
  it("ignores tool filters, which apply per session without a restart", () => {
    const base = '[server.fx]\ncommand = "node"\nargs = ["x.js"]\n';
    const variant = '[server.fx.variant.work]\nenv = { ACCOUNT = "work" }\n';
    const a = parseManifest(base + variant).servers.fx!;
    const b = parseManifest(`${base}tools = { deny = ["drop_*"] }\n${variant}tools = { allow = ["get_*"] }\n`).servers.fx!;
    expect(definitionFingerprint(b)).toBe(definitionFingerprint(a));
    const c = parseManifest(base.replace("x.js", "y.js")).servers.fx!;
    expect(definitionFingerprint(c)).not.toBe(definitionFingerprint(a));
  });
});

describe("turno mcp list", () => {
  it("shows tool filters, the server's and each variant's", async () => {
    sb.write(
      ".config/turno/mcp.toml",
      '[server.fx]\ncommand = "node"\ntools = { allow = ["get_*", "list_*"], deny = ["*_delete"] }\n[server.fx.variant.work]\ntools = { deny = ["*"] }\n[server.plain]\ncommand = "node"\n',
    );
    const r = await run(["mcp", "list"]);
    const fx = r.out.split("\n").find((l) => l.startsWith("fx "))!;
    expect(fx).toContain("tools: allow get_*, list_*, deny *_delete");
    expect(fx).toContain("work tools: deny *");
    expect(r.out.split("\n").find((l) => l.startsWith("plain "))).not.toContain("tools");
    const j = JSON.parse((await run(["mcp", "list", "--json"])).out) as { name: string; tools: unknown; variantTools?: unknown }[];
    expect(j.find((s) => s.name === "fx")).toMatchObject({ tools: { allow: ["get_*", "list_*"], deny: ["*_delete"] }, variantTools: { work: { deny: ["*"] } } });
    expect(j.find((s) => s.name === "plain")).toMatchObject({ tools: null, variantTools: {} });
  });
});
