import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findOnPath } from "../cli/launch.js";
import type { Journal } from "../core/journal.js";

export interface FontFile {
  file: string;
  /** Where the file is published, for installs without @claudio/fonts. */
  url: string;
  sha256: string;
}

export interface FontSource {
  family: string;
  version: string;
  files: FontFile[];
  /** Folder with the files (the @claudio/fonts package); absent means download them. */
  dir?: string;
}

const NF = "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/Meslo/S/";

/** Same values as @claudio/fonts, for an install without that optional package. */
export const FALLBACK: FontSource = {
  family: "MesloLGS Nerd Font",
  version: "3.4.0",
  files: [
    {
      file: "MesloLGSNerdFont-Regular.ttf",
      url: `${NF}Regular/MesloLGSNerdFont-Regular.ttf`,
      sha256: "44ae9b687639c1529ecd01e5d0ae8d98f3b30cb20b02bbe4e6d9fb474c8dee36",
    },
    {
      file: "MesloLGSNerdFont-Bold.ttf",
      url: `${NF}Bold/MesloLGSNerdFont-Bold.ttf`,
      sha256: "9799788a96066045c3f53f2e5bcbe376c6b9adb9514e3276cc84ac42d8b176d0",
    },
    {
      file: "MesloLGSNerdFont-Italic.ttf",
      url: `${NF}Italic/MesloLGSNerdFont-Italic.ttf`,
      sha256: "3dede17df16e62abdae99ea7f13a14cbc391e2cc9429c8dfa1b5349e78758e9c",
    },
    {
      file: "MesloLGSNerdFont-BoldItalic.ttf",
      url: `${NF}Bold-Italic/MesloLGSNerdFont-BoldItalic.ttf`,
      sha256: "734956444bc02c8ea0e7f7effe46c616f2e492734c6afe91049e4735d522542c",
    },
  ],
};

export async function fontSource(): Promise<FontSource> {
  try {
    const pkg = (await import("@claudio/fonts")) as { FAMILY: string; VERSION: string; FONTS: FontFile[]; fontsDir: string };
    return { family: pkg.FAMILY, version: pkg.VERSION, files: pkg.FONTS, dir: pkg.fontsDir };
  } catch {
    return FALLBACK;
  }
}

/** The per-user font folder: no admin rights needed. */
export function userFontDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.CLAUDIO_FONT_DIR) return env.CLAUDIO_FONT_DIR;
  const home = env.HOME ?? "";
  if (platform === "darwin") return join(home, "Library", "Fonts");
  if (platform === "linux") return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "fonts");
  return undefined;
}

export const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

export type FontState = "installed" | "missing" | "different";

export interface FontCheck extends FontFile {
  target: string;
  state: FontState;
}

export function checkFonts(source: FontSource, dir: string): FontCheck[] {
  return source.files.map((f) => {
    const target = join(dir, f.file);
    let state: FontState = "missing";
    if (existsSync(target)) state = sha256(readFileSync(target)) === f.sha256 ? "installed" : "different";
    return { ...f, target, state };
  });
}

export interface InstallOptions {
  dir: string;
  force?: boolean;
  dryRun?: boolean;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Records each file before it is written, for `claudio undo`. */
  journal?: Journal;
}

export type FontAction = "copied" | "downloaded" | "kept" | "skipped";

export interface FontResult extends FontCheck {
  action: FontAction;
}

async function bytesOf(source: FontSource, f: FontFile, doFetch: typeof fetch): Promise<{ buf: Buffer; downloaded: boolean }> {
  if (source.dir) return { buf: readFileSync(join(source.dir, f.file)), downloaded: false };
  const res = await doFetch(f.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`downloading ${f.file}: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), downloaded: true };
}

/**
 * Copy the font files into `dir`. A file that is already there with the right checksum is
 * kept; one with the same name and other contents is skipped unless `force`. Every byte
 * written is checked against the pinned SHA-256 first.
 */
export async function installFonts(source: FontSource, opts: InstallOptions): Promise<FontResult[]> {
  const results: FontResult[] = [];
  for (const check of checkFonts(source, opts.dir)) {
    if (check.state === "installed" || (check.state === "different" && !opts.force)) {
      results.push({ ...check, action: check.state === "installed" ? "kept" : "skipped" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ ...check, action: source.dir ? "copied" : "downloaded" });
      continue;
    }
    const { buf, downloaded } = await bytesOf(source, check, opts.fetch ?? fetch);
    if (sha256(buf) !== check.sha256) throw new Error(`${check.file}: checksum mismatch, nothing written for it`);
    mkdirSync(opts.dir, { recursive: true });
    opts.journal?.save(check.target);
    const tmp = `${check.target}.${process.pid}.tmp`;
    writeFileSync(tmp, buf, { mode: 0o644 });
    renameSync(tmp, check.target);
    opts.journal?.settle(check.target);
    results.push({ ...check, action: downloaded ? "downloaded" : "copied" });
  }
  const wrote = results.some((r) => r.action === "copied" || r.action === "downloaded");
  if (wrote && !opts.dryRun && (opts.platform ?? process.platform) === "linux") {
    const fc = findOnPath("fc-cache", opts.env ?? process.env);
    if (fc) execFileSync(fc, ["-f", opts.dir], { stdio: "ignore" });
  }
  return results;
}
