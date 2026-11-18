import { tildify } from "../../core/paths.js";
import { type FlagSpec, JSON_FLAG, type Parsed, bool, parseFlags, str } from "../args.js";
import { Exit } from "../exit.js";
import { type Io, fail } from "../io.js";
import { emit, jsonOutput } from "../output.js";
import { style } from "../style.js";
import type { BrowserApi } from "./browser.js";

/** `turno browser show --json` and `turno identity show browser:<id> --json` (ADR 0045). */
export const SHOW_JSON = jsonOutput(["id", "dir", "settingsFile", "settings", "problems", "inUse", "holder", "health"]);
/** `turno browser doctor --json`: the shape of `turno doctor --json`. */
export const DOCTOR_JSON = jsonOutput(["ok", "counts", "checks", "fixed"]);
/** `turno browser reputation --json`: one element per identity. */
export const REPUTATION_JSON = jsonOutput(["id", "file", "total", "sites"]);

/**
 * The identity module of turno-browser in the CLI (ADR 0044): identity.json (`show`, `set`, the
 * settings flags of `add`), `turno browser doctor` and `turno browser reputation`. The types
 * come from the package itself (`import type`, ADR 0047); `loadBrowser` refuses a package whose
 * API_VERSION does not fit, so every function used here is there.
 */
type IdentitySettings = NonNullable<ReturnType<BrowserApi["checkIdentitySettings"]>["settings"]>;
type HealthCheck = NonNullable<IdentitySettings["health"]>;
export type SettingsPatch = Parameters<BrowserApi["writeIdentitySettings"]>[1];
type DoctorCheck = Awaited<ReturnType<BrowserApi["runDoctor"]>>["checks"][number];

/** Flags that write identity.json, shared by `add` and `set`. An empty value removes the key. */
export const SETTINGS_FLAGS: FlagSpec = {
  timezone: { type: "string" },
  locale: { type: "string" },
  languages: { type: "string" },
  region: { type: "string" },
  "health-url": { type: "string" },
  "health-text": { type: "string" },
  "health-selector": { type: "string" },
  "no-health": { type: "boolean" },
};

export const SETTINGS_FLAG_NAMES = Object.keys(SETTINGS_FLAGS).map((f) => `--${f}`);

/** The identity.json change the flags ask for; `current` fills the parts of health not given. */
export function settingsPatch(p: Parsed, current?: IdentitySettings): SettingsPatch {
  const patch: SettingsPatch = {};
  const value = (name: string) => {
    const v = str(p, name);
    return v === undefined ? undefined : v.trim() === "" ? null : v.trim();
  };
  for (const key of ["timezone", "locale", "region"] as const) {
    const v = value(key);
    if (v !== undefined) patch[key] = v;
  }
  const langs = value("languages");
  if (langs !== undefined) patch.languages = langs === null ? null : langs.split(",").map((l) => l.trim()).filter(Boolean);
  const url = value("health-url");
  const text = value("health-text");
  const selector = value("health-selector");
  if (bool(p, "no-health")) {
    if (url !== undefined || text !== undefined || selector !== undefined) fail("--no-health does not go with the other --health flags");
    patch.health = null;
  } else if (url !== undefined || text !== undefined || selector !== undefined) {
    const base = current?.health;
    const health: HealthCheck = { url: url ?? base?.url ?? "" };
    const t = text === undefined ? base?.text : (text ?? undefined);
    const s = selector === undefined ? base?.selector : (selector ?? undefined);
    if (t) health.text = t;
    if (s) health.selector = s;
    if (!health.url) fail("a health check needs --health-url (a page only a signed-in user sees)");
    if (!health.text && !health.selector) fail("a health check needs --health-text or --health-selector (what that page shows when signed in)");
    patch.health = health;
  }
  return patch;
}

export function hasSettings(patch: SettingsPatch): boolean {
  return Object.keys(patch).length > 0;
}

function describeHealth(h: HealthCheck): string {
  return [h.url, h.text ? `shows "${h.text}"` : "", h.selector ? `has ${h.selector}` : ""].filter(Boolean).join(" ");
}

export function show(m: BrowserApi, id: string, args: string[], io: Io): number {
  const p = parseFlags(args, JSON_FLAG, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (turno identity add browser:${id})`);
  const { path, settings, problems } = m.checkIdentitySettings(id, io.env);
  const holder = m.inUseBy(id, io.env);
  const health = m.readHealth(id, io.env);
  if (bool(p, "json")) {
    emit(io, p, SHOW_JSON, {
      id: `browser:${id}`,
      dir: tildify(m.identityDir(id, io.env), io.env),
      settingsFile: tildify(path, io.env),
      settings: settings ?? null,
      problems,
      inUse: holder !== undefined,
      holder: holder ?? null,
      health: health ?? null,
    });
    return Exit.ok;
  }
  const s = style(io);
  const rows: [string, string][] = [
    ["profile", tildify(m.identityDir(id, io.env), io.env)],
    ["settings", `${tildify(path, io.env)}${settings || problems.length ? "" : s.muted(" (none: Chrome's own time zone and languages)")}`],
  ];
  if (settings) {
    rows.push(["time zone", settings.timezone ?? s.muted("(the system's)")]);
    if (settings.locale) rows.push(["locale", settings.locale]);
    rows.push(["languages", settings.languages?.join(", ") ?? s.muted(settings.locale ? "(from the locale)" : "(Chrome's)")]);
    if (settings.region) rows.push(["region", settings.region]);
    rows.push(["health check", settings.health ? describeHealth(settings.health) : s.muted("(none)")]);
    rows.push(["created", settings.created]);
    rows.push(["updated", settings.updated]);
  }
  if (health) {
    const state = health.status === "ok" ? s.ok("signed in") : health.status === "needs_auth" ? s.err("NEEDS_AUTH") : s.warn("check failed");
    rows.push(["last check", `${state} ${s.muted(`${health.checkedAt}${health.detail ? `: ${health.detail}` : ""}`)}`]);
  }
  rows.push(["state", holder ? s.warn(holder.replace(/^browser identity "[^"]+" is /, "").replace(/\. .*$/, "")) : s.ok("free")]);
  io.out(s.bold(`browser:${id}`));
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) io.out(s.kv(k, v, width));
  for (const problem of problems) io.out(s.note("err", `identity.json ${problem}`));
  if (health?.status === "needs_auth") io.out(s.note("info", `sign in again: turno browser login ${id}`));
  return Exit.ok;
}

const SET_FLAGS: FlagSpec = { ...SETTINGS_FLAGS, "dry-run": { type: "boolean" } };

export function set(m: BrowserApi, id: string, args: string[], io: Io): number {
  const p = parseFlags(args, SET_FLAGS, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (turno identity add browser:${id})`);
  const patch = settingsPatch(p, m.checkIdentitySettings(id, io.env).settings);
  if (!hasSettings(patch)) return fail(`nothing to set: pass ${SETTINGS_FLAG_NAMES.join(", ")} (an empty value removes one)`);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would update identity.json of "${id}": ${JSON.stringify(patch)}`);
    return Exit.ok;
  }
  m.writeIdentitySettings(id, patch, io.env);
  io.out(`updated identity.json of "${id}"; the next Chrome start of browser-${id} uses it\n`);
  return show(m, id, [], io);
}

const DOCTOR_FLAGS: FlagSpec = { fix: { type: "boolean" }, "no-launch": { type: "boolean" }, ...JSON_FLAG };

const SECTIONS: [string, (area: string) => boolean][] = [
  ["Chrome", (a) => a === "chrome"],
  ["System", (a) => a === "system"],
  ["Identities", (a) => a === "identities" || a.startsWith("identity ")],
];

export async function doctor(m: BrowserApi, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, DOCTOR_FLAGS, 0);
  const json = bool(p, "json");
  const report = await m.runDoctor({ env: io.env, fix: bool(p, "fix"), launch: !bool(p, "no-launch") });
  const failed = report.checks.some((c) => c.level === "fail");
  const exit = failed ? Exit.failure : Exit.ok;
  const status = (c: DoctorCheck) => (c.level === "info" ? "skip" : c.level);
  const n = (l: DoctorCheck["level"]) => report.checks.filter((c) => c.level === l).length;
  if (json) {
    emit(io, p, DOCTOR_JSON, {
      ok: !failed,
      counts: { ok: n("ok"), warn: n("warn"), fail: n("fail"), skip: n("info") },
      fixed: report.fixed,
      checks: report.checks.map((c) => ({
        area: c.area,
        status: status(c),
        text: c.text,
        fix: c.level === "ok" ? null : (c.fix ?? null),
        auto: Boolean(c.auto) && (c.level === "warn" || c.level === "fail"),
        manual: c.level === "ok" ? null : (c.manual ?? null),
      })),
    });
    return exit;
  }
  const s = style(io);
  for (const f of report.fixed) io.out(s.check("ok", `fixed: ${f}`));
  if (report.fixed.length) io.out("");
  const ICON = { ok: "ok", warn: "warn", fail: "err", info: "skip" } as const;
  let first = true;
  for (const [title, has] of SECTIONS) {
    const rows = report.checks.filter((c) => has(c.area));
    if (!rows.length) continue;
    if (!first) io.out("");
    first = false;
    io.out(s.header(title));
    let area = "";
    for (const c of rows) {
      if (c.area.startsWith("identity ") && c.area !== area) io.out(`  ${s.bold(`browser:${c.area.slice("identity ".length)}`)}`);
      area = c.area;
      const indent = c.area.startsWith("identity ") ? 4 : 2;
      const text = c.level === "fail" ? s.err(c.text) : c.level === "info" ? s.muted(c.text) : c.text;
      io.out(s.note(ICON[c.level], text, indent));
      if (c.level === "ok") continue;
      const under = " ".repeat(indent + 2);
      const label = c.level === "info" ? "optional:" : "fix:";
      if (c.fix) io.out(s.wrap(`${under}${s.muted(label)} `, `${c.level === "info" ? s.muted(c.fix) : s.bold(c.fix)}${c.auto ? s.muted(" (runs with --fix)") : ""}`));
      else if (c.manual) io.out(s.wrap(`${under}${s.muted("manual:")} `, c.manual));
    }
  }
  io.out("");
  io.out([`${n("ok")} ok`, n("warn") ? `${n("warn")} warning${n("warn") === 1 ? "" : "s"}` : "", n("fail") ? `${n("fail")} failure${n("fail") === 1 ? "" : "s"}` : ""].filter(Boolean).join(", "));
  return exit;
}

export function reputation(m: BrowserApi, args: string[], io: Io, checkId: (id: string) => string): number {
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = p.positionals[0] === undefined ? undefined : checkId(p.positionals[0].replace(/^browser:/, ""));
  let report: ReturnType<typeof m.reputationReport>;
  try {
    report = m.reputationReport(io.env, id ? [id] : undefined);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (bool(p, "json")) {
    emit(
      io,
      p,
      REPUTATION_JSON,
      report.identities.map((i) => ({ id: `browser:${i.id}`, file: tildify(i.file, io.env), total: i.total, sites: i.sites })),
    );
    return Exit.ok;
  }
  const s = style(io);
  if (!report.identities.length) {
    io.out("No browser identities yet. Create one with `turno identity add browser:<id>`.");
    return Exit.ok;
  }
  const TREND = { up: s.warn("up"), down: s.ok("down"), flat: s.muted("flat") };
  for (const [i, ident] of report.identities.entries()) {
    if (i) io.out("");
    io.out(s.header(`browser:${ident.id}`));
    if (!ident.sites.length) {
      io.out(`  ${s.muted("no challenges recorded")}`);
      continue;
    }
    const head = ["site", "total", "captcha", "verify", "block", "7d", "prev 7d", "trend", "last seen"].map((h) => s.muted(h));
    const rows = ident.sites.map((x) => [x.site, String(x.total), String(x.captcha), String(x.verify), String(x.block), String(x.last7d), String(x.prev7d), TREND[x.trend], x.lastSeen]);
    const right = { align: "right" as const };
    for (const l of s.table([head, ...rows], { columns: [{}, right, right, right, right, right, right, {}, { drop: 1 }] })) io.out(l);
  }
  return Exit.ok;
}
