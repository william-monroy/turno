import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { storeKeychainSecret } from "../../core/secrets.js";
import { type Command, fail } from "../io.js";

const run = promisify(execFile);

const USAGE = `Usage:
  claudio secret set <service>     read a value from stdin and store it in the Keychain
  claudio secret has <service>     exit 0 when the Keychain item exists
  claudio secret rm <service>      delete the Keychain item

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

export const command: Command = {
  summary: "store MCP secrets in the macOS Keychain",
  usage: USAGE,
  async run(args, io) {
    const [sub, service] = args;
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
