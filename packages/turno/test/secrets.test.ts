import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as secret } from "../src/cli/commands/secret.js";
import { NO_SECRET_STORE, keychainAddLine, keychainResolver, secretStore, securityQuote } from "../src/core/secrets.js";
import { fakeCommand, fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let log: string;
let stdin: string;
/** A value with every character the `security -i` quoting has to handle. */
const SECRET = `s3cr"et\\ va'lue $HOME`;

beforeEach(() => {
  sb = sandbox();
  log = join(sb.home, "argv.log");
  stdin = join(sb.home, "stdin.log");
});
afterEach(() => sb.cleanup());

/** A fake `security` that logs argv and stdin, and knows one item called "known". */
function fakeSecurity(): void {
  fakeCommand(
    sb,
    "security",
    `printf '%s\\n' "$@" >> "${log}"
/bin/cat >> "${stdin}"
case "$1" in
  -i) exit 0 ;;
  find-generic-password)
    if [ "$3" = "known" ]; then [ "$4" = "-w" ] && printf 'hunter2\\n'; exit 0; fi
    echo "security: The specified item could not be found in the keychain." >&2; exit 44 ;;
  delete-generic-password) [ "$3" = "known" ] && exit 0; exit 44 ;;
esac
exit 1`,
  );
}

/** A fake `secret-tool` backed by one file per account under the sandbox. */
function fakeSecretTool(): void {
  const dir = join(sb.home, "secret-service");
  mkdirSync(dir, { recursive: true });
  fakeCommand(
    sb,
    "secret-tool",
    `printf '%s\\n' "$@" >> "${log}"
cmd="$1"; shift
[ "$cmd" = store ] && shift
[ "$1" = service ] && [ "$2" = turno ] && [ "$3" = account ] || { echo "bad attributes" >&2; exit 2; }
f="${dir}/$4"
case "$cmd" in
  store) /bin/cat > "$f" ;;
  lookup) [ -f "$f" ] || exit 1; /bin/cat "$f" ;;
  clear) /bin/rm -f "$f" ;;
esac`,
  );
}

describe("Keychain store (macOS)", () => {
  it("stores through `security -i` so the value never appears in argv", async () => {
    fakeSecurity();
    const store = secretStore(sb.env, "darwin")!;
    expect(store.kind).toBe("keychain");
    await store.set("turno/linear/api-key", SECRET);
    const argv = readFileSync(log, "utf8");
    expect(argv).toBe("-i\n");
    expect(argv).not.toContain("hunter");
    expect(argv).not.toContain("va'lue");
    expect(readFileSync(stdin, "utf8")).toBe(keychainAddLine("turno/linear/api-key", SECRET));
    expect(readFileSync(stdin, "utf8")).toContain("-T /usr/bin/security\n");
  });

  it("quotes words the way security -i splits them", () => {
    expect(securityQuote('a b"c\\d')).toBe('"a b\\"c\\\\d"');
    expect(() => keychainAddLine("svc", "two\nlines")).toThrow(/line break/);
  });

  it("reads, checks and deletes items, and tells a missing item apart", async () => {
    fakeSecurity();
    const store = secretStore(sb.env, "darwin")!;
    expect(await store.get("known")).toBe("hunter2");
    expect(await store.get("other")).toBeUndefined();
    expect(await store.has("known")).toBe(true);
    expect(await store.has("other")).toBe(false);
    expect(await store.remove("other")).toBe(false);
    expect(await store.remove("known")).toBe(true);
    await expect(keychainResolver(sb.env, "darwin")("keychain:other")).rejects.toThrow(/no Keychain item "other" \(turno secret set other\)/);
    expect(await keychainResolver(sb.env, "darwin")("keychain:known")).toBe("hunter2");
  });
});

describe("Secret Service store (Linux)", () => {
  it("stores with secret-tool attributes service=turno account=<name>, value on stdin", async () => {
    fakeSecretTool();
    const store = secretStore(sb.env, "linux")!;
    expect(store.kind).toBe("libsecret");
    await store.set("vault-token", SECRET);
    const argv = readFileSync(log, "utf8");
    expect(argv).toBe("store\n--label=turno: vault-token\nservice\nturno\naccount\nvault-token\n");
    expect(argv).not.toContain("s3cr");
    expect(await store.get("vault-token")).toBe(SECRET);
    expect(await keychainResolver(sb.env, "linux")("keychain:vault-token")).toBe(SECRET);
    expect(await store.has("missing")).toBe(false);
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.remove("vault-token")).toBe(true);
    expect(await store.remove("vault-token")).toBe(false);
  });
});

describe("no secret store", () => {
  function bare(): NodeJS.ProcessEnv {
    const empty = join(sb.home, "empty-bin");
    mkdirSync(empty, { recursive: true });
    return { ...sb.env, PATH: empty };
  }

  it("resolver says what to install or use instead, in one line", async () => {
    const env = bare();
    expect(secretStore(env, "linux")).toBeUndefined();
    expect(secretStore(env, "darwin")).toBeUndefined();
    const err = await keychainResolver(env, "linux")("keychain:x").catch((e: Error) => e);
    expect((err as Error).message).toContain(NO_SECRET_STORE);
    expect((err as Error).message).not.toContain("\n");
    expect(await keychainResolver(env, "linux")("plain")).toBe("plain");
  });

  it("secret commands fail with a usage error, never a stack trace", async () => {
    const env = bare();
    await expect(secret.run(["has", "x"], fakeIo(env))).rejects.toMatchObject({ name: "UsageError", message: NO_SECRET_STORE });
    await expect(secret.run(["rm", "x"], fakeIo(env))).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("turno secret", () => {
  beforeEach(() => {
    // One fake per platform, so the command finds a store on macOS and on Linux.
    fakeSecurity();
    fakeSecretTool();
    writeFileSync(join(sb.home, "secret-service", "known"), "hunter2");
  });

  it("has, rm and list never print a value", async () => {
    const io = fakeIo(sb.env);
    expect(await secret.run(["has", "known"], io)).toBe(0);
    expect(await secret.run(["has", "nope"], io)).toBe(1);
    sb.write(".config/turno/mcp.toml", '[server.a]\ncommand = "x"\nenv = { A = "keychain:known", B = "keychain:nope" }\n');
    expect(await secret.run(["list"], io)).toBe(1);
    expect(io.lines.join("\n")).toMatch(/stored {3}keychain:known/);
    expect(io.lines.join("\n")).toMatch(/MISSING {2}keychain:nope {2}\(turno secret set nope\)/);
    expect(await secret.run(["rm", "known"], io)).toBe(0);
    expect(await secret.run(["rm", "nope"], io)).toBe(1);
    expect(io.lines.join("\n")).not.toContain("hunter2");
  });

  it("prints help", async () => {
    const io = fakeIo(sb.env);
    expect(await secret.run(["--help"], io)).toBe(0);
    expect(io.lines.join("\n")).toContain("Secret Service");
  });
});
