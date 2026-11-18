import { spawn } from "node:child_process";
import { join } from "node:path";
import { paths, writePrivateFile } from "./paths.js";
import { compareVersions, packageInfo } from "./version.js";
import { hasFields, readState } from "./state-file.js";

/** Cache of the last registry check, in the state folder. */
export interface UpdateState {
  checkedAt: number;
  channel: string;
  latest?: string;
  error?: string;
  notifiedAt?: number;
}

const DAY = 24 * 3600 * 1000;

/** Strict semver 2.0.0 (no leading v, no ranges, no URLs): what may follow `turno-cli@`. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(v: unknown): v is string {
  return typeof v === "string" && v.length <= 256 && SEMVER.test(v);
}

function file(env: NodeJS.ProcessEnv): string {
  return join(paths(env).state, "update.json");
}

const isUpdateState = (v: unknown): v is UpdateState => hasFields(v, { checkedAt: "number", channel: "string" });

function readUpdateState(env: NodeJS.ProcessEnv): UpdateState | undefined {
  return readState(file(env), isUpdateState);
}

function writeUpdateState(env: NodeJS.ProcessEnv, s: UpdateState): void {
  writePrivateFile(file(env), `${JSON.stringify(s)}\n`, env);
}

const truthy = (v: string | undefined): boolean =>
  v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * Why the environment turns update checks off: TURNO_NO_UPDATE_CHECK, TURNO_NO_UPDATE_NOTIFIER
 * (gh's GH_NO_UPDATE_NOTIFIER), NO_UPDATE_NOTIFIER, DO_NOT_TRACK, CI.
 */
export function envOptOut(env: NodeJS.ProcessEnv): string | undefined {
  if (
    [env.TURNO_NO_UPDATE_CHECK, env.TURNO_NO_UPDATE_NOTIFIER, env.NO_UPDATE_NOTIFIER, env.DO_NOT_TRACK].some(truthy)
  ) {
    return "turned off by the environment";
  }
  if (truthy(env.CI)) return "running in CI";
  return undefined;
}

/**
 * Why update checks are off, or undefined when they run. Off for unpublished (private)
 * copies, in CI, with TURNO_NO_UPDATE_CHECK, TURNO_NO_UPDATE_NOTIFIER, NO_UPDATE_NOTIFIER or DO_NOT_TRACK, and with
 * `update_check = false` in config.toml.
 */
export function updateChecksOff(env: NodeJS.ProcessEnv, configured = true): string | undefined {
  if (packageInfo().private) return "this copy is not published to a registry";
  const off = envOptOut(env);
  if (off) return off;
  if (!configured) return "update_check = false in config.toml";
  return undefined;
}

export function registryUrl(env: NodeJS.ProcessEnv, name: string, channel: string): string {
  const base = (env.TURNO_REGISTRY || env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  return `${base}/${name.replace("/", "%2F")}/${encodeURIComponent(channel)}`;
}

/** Ask the registry for the version of a dist-tag. Sends nothing but the package name. */
export async function fetchLatest(
  env: NodeJS.ProcessEnv,
  channel = "latest",
  doFetch: typeof fetch = fetch,
): Promise<UpdateState> {
  const { name, version } = packageInfo();
  const state: UpdateState = {
    checkedAt: Date.now(),
    channel,
    ...(readUpdateState(env)?.notifiedAt ? { notifiedAt: readUpdateState(env)!.notifiedAt! } : {}),
  };
  try {
    const res = await doFetch(registryUrl(env, name, channel), {
      headers: { accept: "application/json", "user-agent": `turno/${version}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) state.error = `registry answered HTTP ${res.status}`;
    else {
      // The answer becomes part of an install command: accept a plain version only.
      const v = ((await res.json()) as { version?: unknown }).version;
      if (isSemver(v)) state.latest = v;
      else state.error = "the registry answered with an invalid version";
    }
  } catch (err) {
    state.error = (err as Error).message;
  }
  writeUpdateState(env, state);
  return state;
}

/** A newer version from the last check, if any. */
export function availableUpdate(env: NodeJS.ProcessEnv): string | undefined {
  const s = readUpdateState(env);
  if (!s?.latest) return undefined;
  return compareVersions(s.latest, packageInfo().version) > 0 ? s.latest : undefined;
}

/**
 * For interactive commands: start a background check when the last one is a day old, and
 * return a one-line notice (at most once a day) when a newer version is known.
 */
export function updateNotice(env: NodeJS.ProcessEnv, configured: boolean, entry = process.argv[1]): string | undefined {
  if (updateChecksOff(env, configured)) return undefined;
  const s = readUpdateState(env);
  const now = Date.now();
  if ((!s || now - s.checkedAt > DAY) && entry) {
    try {
      const child = spawn(process.execPath, [entry, "__update-check"], { detached: true, stdio: "ignore", env });
      child.unref();
    } catch {
      /* best effort */
    }
  }
  const latest = availableUpdate(env);
  if (!latest || (s?.notifiedAt && now - s.notifiedAt < DAY)) return undefined;
  writeUpdateState(env, { ...s!, notifiedAt: now });
  return `turno ${latest} is available (you have ${packageInfo().version}): turno upgrade`;
}
