#!/usr/bin/env node
/**
 * Bundles a claude.ai artifact's own files and its assets into a package that a session of
 * another turno profile can import.
 *
 *   node pack.mjs --from <dir> --url <artifact url> --title <title> --profile <source profile>
 *                 [--type <type title>] [--main <path>] [--blob <id>=<file> ...] <path> ...
 *
 * <dir> is where `Artifact read` saved the files (the artifact's folder in the scratchpad). Each
 * positional <path> is a published path under <dir> (for example project/canvas.json). Each
 * --blob maps an asset id (the 32 hex characters after /_blob/) to the local file `Artifact read`
 * saved for it. The package goes to $XDG_CACHE_HOME/turno/artifacts/<slug>-<UTC stamp>/ (default
 * ~/.cache/turno/artifacts) with files/, assets/ and manifest.json. stdout prints only the package
 * path; notes go to stderr.
 *
 * Fails loudly, before writing anything, on a missing file, a path outside <dir>, an asset no file
 * cites (it would be copied for nothing) and a cited asset with no --blob.
 *
 * Dependency free: it runs on the Node.js that runs turno.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const TEXT = [".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".svg", ".txt", ".xml"];
const BLOB = /\/_blob\/([0-9a-f]{32})/g;
const ID = /^[0-9a-f]{32}$/;
const USAGE =
  "usage: pack.mjs --from <dir> --url <url> --title <title> --profile <profile> [--type <type>] [--main <path>] [--blob <id>=<file> ...] <path> ...";

function die(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const isFile = (file) => existsSync(file) && statSync(file).isFile();
const isText = (path) => TEXT.includes(extname(path).toLowerCase());

/** ASCII slug of the title: accents dropped, lower case, runs of other characters as one dash. */
function slugOf(title) {
  const plain = [...title.normalize("NFKD")].filter((c) => c.charCodeAt(0) < 128).join("");
  const slug = plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "artifact";
}

/** UTC stamp like 20261117-183005. */
function stampOf(date) {
  return date.toISOString().slice(0, 19).replace(/-/g, "").replace("T", "-").replace(/:/g, "");
}

function cacheRoot(env) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "turno", "artifacts");
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      profile: { type: "string" },
      type: { type: "string" },
      main: { type: "string" },
      blob: { type: "string", multiple: true, default: [] },
    },
  });
} catch (error) {
  die(`${error.message}\n${USAGE}`, 2);
}
const { values: opts, positionals: paths } = args;
for (const name of ["from", "url", "title", "profile"]) {
  if (!opts[name]) die(`--${name} is required\n${USAGE}`, 2);
}
if (paths.length === 0) die(`name at least one published path\n${USAGE}`, 2);

if (!existsSync(opts.from) || !statSync(opts.from).isDirectory()) die(`the folder ${opts.from} does not exist`);
const src = realpathSync(opts.from);
const main = opts.main ?? paths[0];
if (!paths.includes(main)) die(`the main file ${main} is not among the files`);
const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
if (dupes.length > 0) die(`paths named twice: ${[...new Set(dupes)].join(", ")}`);

// Assets: --blob <32 hex id>=<existing file>, each id once.
const blobs = new Map();
for (const b of opts.blob) {
  const at = b.indexOf("=");
  const id = at < 0 ? b : b.slice(0, at);
  const file = at < 0 ? "" : b.slice(at + 1);
  if (!ID.test(id) || !isFile(file)) die(`invalid --blob: ${b} (a 32 hex id = an existing file)`);
  if (blobs.has(id)) die(`--blob ${id} given twice`);
  blobs.set(id, realpathSync(file));
}

// Files: inside the source folder (after resolving symlinks), present, and scanned for assets.
const files = [];
const referenced = new Map();
const inside = (file) => {
  const rel = relative(src, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
for (const p of paths) {
  // Checked as written (a published path never climbs out) and again after resolving symlinks.
  const target = resolve(src, p);
  if (isAbsolute(p) || !inside(target)) die(`${p} is outside ${src}`);
  if (!existsSync(target)) die(`${p} is missing in ${src}`);
  const full = realpathSync(target);
  if (!inside(full)) die(`${p} is outside ${src}`);
  if (!statSync(full).isFile()) die(`${p} is missing in ${src} (not a file)`);
  if (isText(p)) {
    for (const [, id] of readFileSync(full, "utf8").matchAll(BLOB)) referenced.set(id, (referenced.get(id) ?? 0) + 1);
  }
  files.push({ path: p, full, bytes: statSync(full).size, sha256: sha256(full) });
}

const missing = [...referenced.keys()].filter((id) => !blobs.has(id)).sort();
if (missing.length > 0) die(`the files cite assets with no --blob: ${missing.join(", ")}`);
const unused = [...blobs.keys()].filter((id) => !referenced.has(id)).sort();
if (unused.length > 0) die(`assets no file cites: ${unused.join(", ")}`);

// Write. The package is private to this user, which every profile's sessions run as.
const root = cacheRoot(process.env);
mkdirSync(root, { recursive: true, mode: 0o700 });
const out = join(root, `${slugOf(opts.title)}-${stampOf(new Date())}`);
try {
  mkdirSync(out, { mode: 0o700 });
} catch (error) {
  die(error.code === "EEXIST" ? `the package ${out} already exists; run it again in a second` : error.message);
}
try {
  const dirs = new Set([join(out, "files"), join(out, "assets")]);
  for (const f of files) dirs.add(dirname(join(out, "files", f.path)));
  for (const d of [...dirs].sort()) mkdirSync(d, { recursive: true, mode: 0o700 });
  for (const f of files) {
    const dest = join(out, "files", f.path);
    copyFileSync(f.full, dest);
    chmodSync(dest, 0o600);
  }
  const assets = [];
  for (const [id, file] of [...blobs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const name = id + extname(file);
    const dest = join(out, "assets", name);
    copyFileSync(file, dest);
    chmodSync(dest, 0o600);
    assets.push({ id, file: name, references: referenced.get(id), sha256: sha256(file) });
  }
  const manifest = {
    version: 1,
    source: { url: opts.url, profile: opts.profile, type: opts.type ?? null },
    title: opts.title,
    main,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    assets,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const refs = assets.reduce((n, a) => n + a.references, 0);
  process.stdout.write(`${out}\n`);
  process.stderr.write(`${files.length} files, ${assets.length} assets (${refs} references)\n`);
} catch (error) {
  rmSync(out, { recursive: true, force: true });
  die(`could not write the package: ${error.message}`);
}
