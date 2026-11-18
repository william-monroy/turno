import { DRY_RUN, JSON_FLAG, bool, flagsOf, parseFlags, str } from "../args.js";
import { type Sub, group } from "../group.js";
import { nextStep } from "../hints.js";
import { type Command, type Io, fail, needsAnswer, noInputReason } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { readHidden, readStdinText, readVisible, stdinIsTty } from "../secret-input.js";
import { OPTIONAL, notInstalled } from "../optional.js";
import type { BrowserApi, BrowserDeps } from "./browser.js";

/**
 * `turno browser vault`: the credential vault of a browser identity (ADR 0054). Values go
 * from a hidden prompt or stdin straight to turno-browser, which keeps them in the secret store;
 * nothing here prints, logs or passes one as an argument.
 */

/** `turno browser vault list --json` (ADR 0045). */
const VAULT_JSON = jsonOutput(["identity", "submit", "sites"]);

/** How the vault reads what a person types; tests replace it. */
export interface VaultInput {
  /** True when a person types on a terminal (hidden prompts), false when stdin is a pipe. */
  isTty(): boolean;
  hidden(prompt: string): Promise<string>;
  visible(prompt: string): Promise<string>;
  /** All of stdin. */
  stdin(): Promise<string>;
}

const terminalInput: VaultInput = { isTty: stdinIsTty, hidden: readHidden, visible: readVisible, stdin: readStdinText };

const ADD_FLAGS = {
  url: { type: "string", multiple: true },
  username: { type: "string" },
  totp: { type: "boolean" },
  ...DRY_RUN,
} as const;

function ids(mod: BrowserApi, io: Io, args: string[], count: number, usage: string): string[] {
  const words = args.slice(0, count);
  if (words.length < count || words.some((w) => !w)) return fail(`usage: turno browser vault ${usage}`);
  try {
    mod.assertIdentityId(words[0]!);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!mod.identityExists(words[0]!, io.env)) return fail(`browser identity "${words[0]}" does not exist (turno browser add ${words[0]})`);
  return words;
}

async function add(mod: BrowserApi, args: string[], io: Io, input: VaultInput): Promise<number> {
  const p = parseFlags(args, ADD_FLAGS, 2);
  const [id, site] = ids(mod, io, p.positionals, 2, "add <identity> <site> --url <sign-in page> [--username <name>] [--totp]");
  const urls = (p.values.url as string[] | undefined) ?? [];
  if (!urls.length) return fail("give the sign-in page with --url (for example --url https://github.com/login)");
  const withTotp = bool(p, "totp");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would store a username, a password${withTotp ? " and a TOTP secret" : ""} for ${site} in browser identity "${id}"`);
    return 0;
  }
  let username = str(p, "username");
  let password: string;
  let totp: string | undefined;
  if (input.isTty()) {
    // Hidden prompts wait for a person: never with --no-input or inside an agent session.
    if (noInputReason(io.env)) needsAnswer("browser vault add", "the password on stdin (and --username)");
    username ??= await input.visible(`Username for ${site}: `);
    password = await input.hidden(`Password for ${site} (input hidden): `);
    if (withTotp) totp = await input.hidden("TOTP secret or otpauth:// URI (input hidden): ");
  } else {
    if (!username) return fail("give --username when the password comes on stdin");
    const lines = (await input.stdin()).split(/\r?\n/);
    password = lines[0] ?? "";
    if (withTotp) totp = lines[1]?.trim() || undefined;
    if (withTotp && !totp) return fail("--totp reads the TOTP secret from the second line of stdin, and it is empty");
  }
  if (!password) return fail("the password is empty; nothing was stored");
  const entry = await mod.vaultAdd(id!, site!, { urls, username: username ?? "", password, ...(totp ? { totp } : {}) }, { env: io.env });
  io.out(`stored the credentials of ${entry.site} for browser identity "${id}" (username, password${entry.totp ? ", TOTP secret" : ""}) in the secret store`);
  io.out(`origins: ${entry.origins.join(", ")}`);
  nextStep(io, `an agent on browser-${id} signs in with the browser_login tool (site "${entry.site}") on that sign-in page`);
  return 0;
}

async function list(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 1);
  const [id] = ids(mod, io, p.positionals, 1, "list <identity> [--json]");
  const info = await mod.vaultList(id!, { env: io.env });
  if (bool(p, "json")) {
    emit(io, p, VAULT_JSON, info);
    return 0;
  }
  io.out(`browser identity "${id}": ${info.submit === "auto" ? "browser_login submits the form itself" : "browser_login fills, the agent clicks sign in"} (turno browser vault submit ${id} auto|confirm)`);
  if (!info.sites.length) {
    io.out(`No credentials yet. Add some with \`turno browser vault add ${id} <site> --url <sign-in page>\`.`);
    return 0;
  }
  const width = Math.max(...info.sites.map((s) => s.site.length));
  for (const s of info.sites) {
    const state = s.stored ? "" : "  MISSING from the secret store";
    io.out(`${s.site.padEnd(width)}  ${s.totp ? "password+totp" : "password     "}  ${s.origins.join(", ")}${state}`);
  }
  return info.sites.every((s) => s.stored) ? 0 : 1;
}

async function remove(mod: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DRY_RUN, 2);
  const [id, site] = ids(mod, io, p.positionals, 2, "remove <identity> <site> [--dry-run]");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would delete the credentials of ${site} from browser identity "${id}"`);
    return 0;
  }
  if (!(await mod.vaultRemove(id!, site!, { env: io.env }))) {
    io.out(`browser identity "${id}" has no credentials for ${site}`);
    return 1;
  }
  io.out(`removed the credentials of ${site} from browser identity "${id}"`);
  return 0;
}

function submit(mod: BrowserApi, args: string[], io: Io): number {
  const p = parseFlags(args, DRY_RUN, 2);
  const [id, mode] = ids(mod, io, p.positionals, 2, "submit <identity> <confirm|auto>");
  if (mode !== "confirm" && mode !== "auto") return fail(`submit takes "confirm" (the agent clicks sign in) or "auto" (browser_login submits), not "${mode}"`);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would set browser_login of "${id}" to ${mode}`);
    return 0;
  }
  mod.vaultSetSubmit(id!, mode, { env: io.env });
  io.out(mode === "auto" ? `browser_login now submits the sign-in form itself for "${id}"` : `browser_login now only fills the form for "${id}"; the agent clicks sign in`);
  return 0;
}

const FOOTER = `The vault keeps a username, a password and optionally a TOTP secret per site for one
browser identity, only in the secret store (the macOS Keychain or the Linux Secret Service).
The browser_login tool fills them into the site's sign-in page without the agent seeing them,
and only on the origins given with --url. In a terminal the password and the TOTP secret are
asked with hidden prompts; from a pipe, the first line of stdin is the password and, with
--totp, the second line is the TOTP secret (base32, or the otpauth:// URI of the QR code).`;

/** The `browser vault` group; `load` is the browser group's loader. */
export function vaultCommand(deps: BrowserDeps, input: VaultInput = terminalInput): Command {
  const withModule =
    (run: (mod: BrowserApi, args: string[], io: Io) => Promise<number> | number): Sub["run"] =>
    async (args, io) => {
      const mod = await deps.load(io);
      if (!mod) return fail(notInstalled(OPTIONAL.browser));
      try {
        return await run(mod, args, io);
      } catch (err) {
        const name = (err as Error).name;
        if (name === "VaultError" || name === "IdentityError" || name === "TotpError") return fail((err as Error).message);
        throw err;
      }
    };
  const subs: Record<string, Sub> = {
    add: {
      summary: "store a site's username, password and optional TOTP secret (asked hidden, or on stdin)",
      synopsis: "<identity> <site> --url <sign-in page> [--url <url>]... [--username <name>] [--totp] [--dry-run]",
     
      flags: flagsOf(ADD_FLAGS),
      run: withModule((mod, args, io) => add(mod, args, io, input)),
    },
    list: { summary: "the sites in an identity's vault (never the values)", synopsis: "<identity> [--json]", flags: ["--json"], json: VAULT_JSON, run: withModule(list) },
    remove: { summary: "delete a site's credentials", synopsis: "<identity> <site> [--dry-run]", flags: ["--dry-run"], run: withModule(remove) },
    rm: { summary: "same as remove", hidden: true, run: withModule(remove) },
    submit: {
      summary: "let browser_login submit the form (auto) or leave the click to the agent (confirm, default)",
      synopsis: "<identity> <confirm|auto> [--dry-run]",
     
      flags: ["--dry-run"],
      run: withModule(submit),
    },
  };
  return group("browser vault", "credentials browser_login fills without showing them", subs, {
    footer: FOOTER,
    examples: [
      "turno browser vault add work github --url https://github.com/login --username alice --totp",
      "printf '%s\\n' \"$PASSWORD\" | turno browser vault add work mail --url https://mail.example.com --username alice@example.com",
      "turno browser vault list work",
      "turno browser vault list work --json",
      "turno browser vault submit work auto",
      "turno browser vault remove work github --dry-run",
    ],
  });
}
