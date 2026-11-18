import { readFileSync } from "node:fs";
import { paths, tildify } from "../../core/paths.js";
import { SecretError, type SecretStore, requireSecretStore } from "../../core/secrets.js";
import { JSON_FLAG, bool, flagsOf, parseFlags } from "../args.js";
import { nextStep } from "../hints.js";
import { type Command, type Io, fail, needsAnswer, noInputReason } from "../io.js";
import { answerFields, emit, jsonOutput } from "../output.js";

const USAGE = `Usage:
  turno secret set <service>     read a value from stdin and store it
  turno secret has <service>     exit 0 when the item exists
  turno secret rm <service>      delete the item
  turno secret list [--json]     every keychain: reference in mcp.toml and whether it is stored

Reference it in mcp.toml as "keychain:<service>". Values are never printed and never passed
as a command argument. The store is the login Keychain on macOS and the Secret Service
(libsecret's secret-tool, attributes service=turno account=<service>) on Linux. Without
either, use "env:NAME" references.

Examples:
  $ printf %s "$TOKEN" | turno secret set github-token
  $ turno secret has github-token
  $ turno secret list --json`;

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

/** The store, with its SecretError turned into a one-line usage error. */
function store(io: Io): SecretStore {
  try {
    return requireSecretStore(io.env);
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** keychain:<service> references in mcp.toml. */
export function keychainRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/"keychain:([^"\\]+)"/g)].map((m) => m[1]!))].sort();
}

/** `turno secret list --json`: one element per keychain: reference in mcp.toml (ADR 0045). */
const LIST_JSON = jsonOutput(["service", "stored"]);

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const json = bool(p, "json");
  let text = "";
  try {
    text = readFileSync(paths(io.env).mcpFile, "utf8");
  } catch {
    text = "";
  }
  const refs = keychainRefs(text);
  const s = refs.length ? store(io) : undefined;
  const found = s ? await Promise.all(refs.map((r) => s.has(r))) : [];
  if (json) {
    emit(io, p, LIST_JSON, refs.map((r, i) => ({ service: r, stored: found[i] })));
    return 0;
  }
  if (!refs.length) io.out(`no keychain: references in ${tildify(paths(io.env).mcpFile, io.env)}`);
  for (const [i, r] of refs.entries()) io.out(`${found[i] ? "stored " : "MISSING"}  keychain:${r}${found[i] ? "" : `  (turno secret set ${r})`}`);
  return found.every(Boolean) ? 0 : 1;
}

export const command: Command = {
  summary: "store MCP secrets in the Keychain (macOS) or the Secret Service (Linux)",
  usage: USAGE,
  subcommands: { set: { args: ["any"] }, has: { args: ["any"] }, rm: { args: ["any"] }, list: { flags: flagsOf(JSON_FLAG) } },
  async run(args, io) {
    const [sub] = args;
    const rest = args.slice(1);
    if (sub === "--help" || sub === "-h" || sub === "help" || rest.includes("--help") || rest.includes("-h")) {
      io.out(USAGE);
      return 0;
    }
    if (sub === "list" || sub === undefined) return answerFields(rest, LIST_JSON, io) ? 0 : list(rest, io);
    // One service name and no flags: an unknown flag must not become a service name.
    const service = parseFlags(rest, {}, 1).positionals[0];
    if (!service) return fail(USAGE);
    try {
      switch (sub) {
        case "set": {
          const s = store(io);
          // The hidden prompt waits for a person: never with --no-input or inside an agent.
          if (process.stdin.isTTY && noInputReason(io.env)) needsAnswer("secret set", "the value on stdin");
          const value = await readStdin();
          if (!value) return fail("empty value");
          await s.set(service, value);
          io.out(`stored keychain:${service}`);
          nextStep(io, `use it in mcp.toml as "keychain:${service}"; turno secret list shows which references are stored`);
          return 0;
        }
        case "has":
          if (await store(io).has(service)) {
            io.out(`keychain:${service} exists`);
            return 0;
          }
          io.out(`keychain:${service} not found`);
          return 1;
        case "rm":
          if (!(await store(io).remove(service))) {
            io.out(`keychain:${service} not found`);
            return 1;
          }
          io.out(`removed keychain:${service}`);
          return 0;
        default:
          return fail(USAGE);
      }
    } catch (err) {
      if (err instanceof SecretError) return fail(err.message);
      throw err;
    }
  },
};
