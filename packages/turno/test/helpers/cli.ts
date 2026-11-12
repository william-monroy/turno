import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../../src/cli/io.js";
import type { Sandbox } from "./sandbox.js";

/** An Io that records output lines. */
export function fakeIo(env: NodeJS.ProcessEnv): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    env,
    isTty: false,
    out: (line = "") => lines.push(...line.split("\n")),
    err: (line = "") => errors.push(...line.split("\n")),
  };
}

/** Put an executable shell script named `name` first on the sandbox PATH. */
export function fakeCommand(sb: Sandbox, name: string, script: string): string {
  const dir = join(sb.home, "fakebin");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  if (!sb.env.PATH?.startsWith(dir)) sb.env.PATH = `${dir}:${sb.env.PATH ?? ""}`;
  return file;
}
