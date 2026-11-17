import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;

beforeEach(() => {
  sb = sandbox();
});

afterEach(() => {
  sb.cleanup();
});

async function run(args: string[]) {
  const { main } = await import("../src/cli/main.js");
  const io = fakeIo(sb.env);
  const code = await main(args, io);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe("turno secret flags", () => {
  it("refuses unknown flags and extra arguments", async () => {
    const list = await run(["secret", "list", "--bogus"]);
    expect(list.code).not.toBe(0);
    expect(list.err).toMatch(/unknown option --bogus/);

    const has = await run(["secret", "has", "--bogus"]);
    expect(has.code).not.toBe(0);
    expect(has.err).toMatch(/unknown option --bogus/);

    const extra = await run(["secret", "rm", "a", "b"]);
    expect(extra.code).not.toBe(0);
    expect(extra.err).toMatch(/unexpected argument 'b'/);
  });

  it("prints the usage for --help after a subcommand instead of treating it as a service name", async () => {
    for (const sub of ["set", "has", "rm", "list"]) {
      const r = await run(["secret", sub, "--help"]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/turno secret set <service>/);
    }
  });
});
