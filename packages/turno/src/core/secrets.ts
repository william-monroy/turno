import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Resolves "keychain:<service>" and "env:<NAME>" references; plain values pass through. */
export type SecretResolver = (value: string) => Promise<string>;

export class SecretError extends Error {
  constructor(ref: string, why: string) {
    super(`cannot resolve ${ref}: ${why}`);
    this.name = "SecretError";
  }
}

export function keychainResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return async (value) => {
    if (value.startsWith("env:")) {
      const name = value.slice(4);
      const v = env[name];
      if (v === undefined) throw new SecretError(value, `environment variable ${name} is not set`);
      return v;
    }
    if (value.startsWith("keychain:")) {
      const service = value.slice("keychain:".length);
      try {
        const { stdout } = await run("security", ["find-generic-password", "-s", service, "-w"], { timeout: 10_000 });
        return stdout.replace(/\n$/, "");
      } catch {
        throw new SecretError(value, `no Keychain item with service "${service}" (turno secret set ${service})`);
      }
    }
    return value;
  };
}

/** Store a secret in the login Keychain, readable by /usr/bin/security without a dialog. */
export async function storeKeychainSecret(service: string, secret: string, account = "turno"): Promise<void> {
  await run("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w", secret, "-T", "/usr/bin/security"], {
    timeout: 10_000,
  });
}

export async function resolveRecord(record: Record<string, string>, resolve: SecretResolver): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) out[k] = await resolve(v);
  return out;
}
