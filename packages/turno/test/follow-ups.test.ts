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
    const variant = '[server.fx.variants.work]\nenv = { ACCOUNT = "work" }\n';
    const a = parseManifest(base + variant).servers.fx!;
    const b = parseManifest(`${base}tools = { deny = ["drop_*"] }\n${variant}tools = { allow = ["get_*"] }\n`).servers.fx!;
    expect(definitionFingerprint(b)).toBe(definitionFingerprint(a));
    const c = parseManifest(base.replace("x.js", "y.js")).servers.fx!;
    expect(definitionFingerprint(c)).not.toBe(definitionFingerprint(a));
  });
});
