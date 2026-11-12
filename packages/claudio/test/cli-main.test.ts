import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exhaustedUntil } from "../src/core/exhausted.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const usageArgs: string[][] = [];
vi.mock("../src/cli/commands/usage.js", () => ({
  command: {
    summary: "usage",
    usage: "Usage: claudio usage [--watch]",
    run: async (args: string[]) => {
      usageArgs.push(args);
      return 0;
    },
  },
}));

const { main } = await import("../src/cli/main.js");

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write(".config/claudio/config.toml", '[[projects]]\npath = "~/code"\nprofile = "work"\n');
  sb.write(".local/bin/claude-work", "#!/bin/sh\n", 0o755);
  mkdirSync(join(sb.home, "code"));
});
afterEach(() => sb.cleanup());

describe("main", () => {
  it("maps uso --vigilar to usage --watch", async () => {
    expect(await main(["uso", "--vigilar"], fakeIo(sb.env))).toBe(0);
    expect(usageArgs.at(-1)).toEqual(["--watch"]);
  });

  it("maps resolver and agotada ... hasta", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["resolver", join(sb.home, "code")], io)).toBe(0);
    expect(io.lines).toEqual(["work\x1fwork\x1fproject ~/code\x1f"]);
    expect(await main(["agotada", "work", "hasta", "2099-01-02 03:04"], fakeIo(sb.env))).toBe(0);
    expect(exhaustedUntil("work", sb.env)).toBe(new Date(2099, 0, 2, 3, 4).getTime() / 1000);
  });

  it("reports an unknown profile as a usage error", async () => {
    const io = fakeIo(sb.env);
    expect(await main(["nobody"], io)).toBe(2);
    expect(io.errors[0]).toBe("claudio: no profile 'nobody' (claudio status lists them; claudio setup nobody creates it)");
  });
});
