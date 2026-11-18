import { spawn } from "node:child_process";
import { findOnPath } from "./paths.js";

/**
 * The secret store of this machine: the macOS Keychain through `security`, the Linux Secret
 * Service through libsecret's `secret-tool` (ADR 0018), shared by turno-cli (the `keychain:<name>`
 * references of mcp.toml) and turno-browser (ADR 0053). Values travel on stdin, never in a
 * process argv, and this module never writes them to a file or a log.
 */

export class SecretError extends Error {
  constructor(ref: string, why: string) {
    super(ref ? `cannot resolve ${ref}: ${why}` : why);
    this.name = "SecretError";
  }
}

/** The one-line error when the machine has neither the Keychain nor libsecret. */
export const NO_SECRET_STORE =
  "no secret store found: turno uses the macOS Keychain (security) or libsecret (secret-tool, package libsecret-tools); install one, or use env:NAME references in mcp.toml";

/**
 * Where items live: the login Keychain on macOS, the Secret Service through libsecret's
 * `secret-tool` on Linux. Every item belongs to turno (Keychain account `turno`, libsecret
 * attributes `service=turno account=<name>`); `name` is the item's own key.
 */
export interface SecretStore {
  readonly kind: "keychain" | "libsecret";
  /** Human name for messages. */
  readonly label: string;
  /** The value, or undefined when there is no item. */
  get(service: string): Promise<string | undefined>;
  /** True when an item exists. Never reads the value into turno's output. */
  has(service: string): Promise<boolean>;
  /** Create or replace an item. The value never appears in any process argv. */
  set(service: string, value: string): Promise<void>;
  /** Delete an item; false when there was none. */
  remove(service: string): Promise<boolean>;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command with optional stdin; never rejects (a missing binary is code 127). */
function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string, timeout = 10_000): Promise<Result> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], timeout });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    let done = false;
    const finish = (r: Result) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish({ code: e.code === "ENOENT" ? 127 : 1, stdout: "", stderr: e.message }),
    );
    child.on("close", (code) =>
      finish({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => {
      /* the process exited before reading; its exit code tells */
    });
    child.stdin.end(input ?? "");
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** Service names travel as arguments and in `security -i` lines: keep them to one plain line. */
function checkService(service: string): void {
  if (!service || /[\0\r\n]/.test(service)) throw new SecretError("", `invalid secret name ${JSON.stringify(service)}`);
}

/** Quote one word for a `security -i` command line (double quotes, backslash escapes). */
export function securityQuote(word: string): string {
  return `"${word.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The line `security -i` reads on stdin to store an item; exported for tests. */
export function keychainAddLine(service: string, value: string, account = "turno"): string {
  if (/[\0\r\n]/.test(value))
    throw new SecretError("", "the value has a line break or NUL byte; the Keychain store reads one line");
  return `add-generic-password -U -a ${securityQuote(account)} -s ${securityQuote(service)} -w ${securityQuote(value)} -T /usr/bin/security\n`;
}

/** Exit code of `security` when the item does not exist (errSecItemNotFound). */
const KEYCHAIN_NOT_FOUND = 44;

function keychainStore(bin: string, env: NodeJS.ProcessEnv): SecretStore {
  return {
    kind: "keychain",
    label: "Keychain",
    async get(service) {
      checkService(service);
      const r = await exec(bin, ["find-generic-password", "-s", service, "-w"], env);
      if (r.code === 0) return r.stdout.replace(/\n$/, "");
      if (r.code === KEYCHAIN_NOT_FOUND) return undefined;
      throw new SecretError(`keychain:${service}`, firstLine(r.stderr) || `security exited with ${r.code}`);
    },
    async has(service) {
      checkService(service);
      // Without -w this reads the item's attributes, never its value.
      return (await exec(bin, ["find-generic-password", "-s", service], env)).code === 0;
    },
    async set(service, value) {
      checkService(service);
      // `security -i` reads commands from stdin, so the value never shows in `ps`. The output is
      // not echoed back: an error line could quote the command.
      const r = await exec(bin, ["-i"], env, keychainAddLine(service, value), 60_000);
      if (r.code !== 0)
        throw new SecretError("", `the Keychain did not store ${service} (security exited with ${r.code})`);
    },
    async remove(service) {
      checkService(service);
      const r = await exec(bin, ["delete-generic-password", "-s", service], env);
      if (r.code === 0) return true;
      if (r.code === KEYCHAIN_NOT_FOUND) return false;
      throw new SecretError("", `the Keychain did not delete ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    },
  };
}

/** libsecret attributes of an item: service=turno, account=<name>. */
function attrs(service: string): string[] {
  return ["service", "turno", "account", service];
}

function libsecretStore(bin: string, env: NodeJS.ProcessEnv): SecretStore {
  const lookup = (service: string) => exec(bin, ["lookup", ...attrs(service)], env);
  return {
    kind: "libsecret",
    label: "Secret Service",
    async get(service) {
      checkService(service);
      const r = await lookup(service);
      if (r.code === 0) return r.stdout.replace(/\n$/, "");
      if (!r.stderr.trim()) return undefined; // not found: exit 1, nothing on stderr
      throw new SecretError(`keychain:${service}`, firstLine(r.stderr));
    },
    async has(service) {
      checkService(service);
      return (await lookup(service)).code === 0;
    },
    async set(service, value) {
      checkService(service);
      // secret-tool reads the value from stdin when stdin is not a terminal.
      const r = await exec(bin, ["store", `--label=turno: ${service}`, ...attrs(service)], env, value, 60_000);
      if (r.code !== 0)
        throw new SecretError("", `secret-tool did not store ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    },
    async remove(service) {
      checkService(service);
      if (!(await this.has(service))) return false;
      const r = await exec(bin, ["clear", ...attrs(service)], env);
      if (r.code !== 0)
        throw new SecretError("", `secret-tool did not delete ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      return true;
    },
  };
}

/**
 * The secret store of this machine: `security` on macOS, `secret-tool` elsewhere, found on the
 * PATH of `env`. Undefined when there is none (the caller prints NO_SECRET_STORE).
 */
export function secretStore(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): SecretStore | undefined {
  if (platform === "darwin") {
    const bin = findOnPath("security", env);
    return bin ? keychainStore(bin, env) : undefined;
  }
  const bin = findOnPath("secret-tool", env);
  return bin ? libsecretStore(bin, env) : undefined;
}

/** The store, or a SecretError with the one-line hint. */
export function requireSecretStore(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): SecretStore {
  const store = secretStore(env, platform);
  if (!store) throw new SecretError("", NO_SECRET_STORE);
  return store;
}
