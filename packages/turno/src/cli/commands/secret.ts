import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { storeKeychainSecret } from "../../core/secrets.js";
import { readFileSync } from "node:fs";
import { paths, tildify } from "../../core/paths.js";
import { type Command, type Io, fail } from "../io.js";

const run = promisify(execFile);

const USAGE = `Usage:
  turno secret set <service>     read a value from stdin and store it in the Keychain
  turno secret has <service>     exit 0 when the Keychain item exists
  turno secret rm <service>      delete the Keychain item
  turno secret list [--json]     every keychain: reference in mcp.toml and whether it is stored

Reference it in mcp.toml as "keychain:<service>". Values are never printed.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("value (input hidden, end with Enter): ");
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let value = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (ch: string) => {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
        } else if (ch === "\u0003") {
          process.exit(130);
        } else if (ch === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function exists(service: string): Promise<boolean> {
  try {
    // Without -w: this reads the item's attributes, never its value.
    await run("security", ["find-generic-password", "-s", service], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** keychain:<service> references in mcp.toml. */
export function keychainRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/"keychain:([^"\\]+)"/g)].map((m) => m[1]!))].sort();
}

async function list(args: string[], io: Io): Promise<number> {
  const json = args.includes("--json");
  let text = "";
  try {
    text = readFileSync(paths(io.env).mcpFile, "utf8");
  } catch {
    text = "";
  }
  const refs = keychainRefs(text);
  const found = await Promise.all(refs.map((r) => exists(r)));
  if (json) {
    io.out(JSON.stringify(refs.map((r, i) => ({ service: r, stored: found[i] })), null, 2));
    return 0;
  }
  if (!refs.length) io.out(`no keychain: references in ${tildify(paths(io.env).mcpFile, io.env)}`);
  for (const [i, r] of refs.entries()) io.out(`${found[i] ? "stored " : "MISSING"}  keychain:${r}${found[i] ? "" : `  (turno secret set ${r})`}`);
  return found.every(Boolean) ? 0 : 1;
}

export const command: Command = {
  summary: "store MCP secrets in the macOS Keychain",
  usage: USAGE,
  subcommands: { set: { args: ["any"] }, has: { args: ["any"] }, rm: { args: ["any"] }, list: { flags: ["--json"] } },
  async run(args, io) {
    const [sub, service] = args;
    if (sub === "list" || sub === undefined) return list(args.slice(1), io);
    if (!service) return fail(USAGE);
    switch (sub) {
      case "set": {
        const value = await readStdin();
        if (!value) return fail("empty value");
        await storeKeychainSecret(service, value);
        io.out(`stored keychain:${service}`);
        return 0;
      }
      case "has":
        try {
          await run("security", ["find-generic-password", "-s", service], { timeout: 10_000 });
          io.out(`keychain:${service} exists`);
          return 0;
        } catch {
          io.out(`keychain:${service} not found`);
          return 1;
        }
      case "rm":
        await run("security", ["delete-generic-password", "-s", service], { timeout: 10_000 });
        io.out(`removed keychain:${service}`);
        return 0;
      default:
        return fail(USAGE);
    }
  },
};
