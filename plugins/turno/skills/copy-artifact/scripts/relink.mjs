#!/usr/bin/env node
/**
 * Points a copied artifact's files at the assets uploaded to the new artifact.
 *
 *   node relink.mjs <files dir> <map.json> [--manifest <manifest.json>]
 *
 * <map.json> is {"<old 32 hex id>": "/_blob/<new id>", ...}, one entry per asset in the package
 * manifest. Every text file under <files dir> is rewritten in place, in one pass, so an id is never
 * rewritten twice. Fails loudly, before writing anything, if a file cites an id the map does not
 * know, a mapping is not a /_blob/ url or, with --manifest, the number of replacements of an asset
 * differs from its `references` there; and afterwards if any old id is still present.
 * stdout prints one line per asset with its replacement count.
 *
 * Dependency free: it runs on the Node.js that runs turno.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";

const TEXT = [".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".svg", ".txt", ".xml"];
const BLOB = /\/_blob\/([0-9a-f]{32})/g;
const ID = /^[0-9a-f]{32}$/;
const NEW = /^\/_blob\/([0-9a-f]{32})$/;
const USAGE = "usage: relink.mjs <files dir> <map.json> [--manifest <manifest.json>]";

function die(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return die(`cannot read the ${what} ${file}: ${error.message}`);
  }
}

/** Text files under `dir`, recursively, without following symlinked folders. */
function textFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...textFiles(full));
    else if (TEXT.includes(extname(entry.name).toLowerCase()) && statSync(full).isFile()) out.push(full);
  }
  return out.sort();
}

let args;
try {
  args = parseArgs({ allowPositionals: true, options: { manifest: { type: "string" } } });
} catch (error) {
  die(`${error.message}\n${USAGE}`, 2);
}
const [root, mapFile, ...extra] = args.positionals;
if (!root || !mapFile || extra.length > 0) die(USAGE, 2);
if (!existsSync(root) || !statSync(root).isDirectory()) die(`the folder ${root} does not exist`);

const map = readJson(mapFile, "map");
if (map === null || typeof map !== "object" || Array.isArray(map)) die("the map must be a JSON object");
for (const [old, now] of Object.entries(map)) {
  if (!ID.test(old) || typeof now !== "string" || !NEW.test(now)) die(`invalid map entry: ${old} -> ${now}`);
}
const olds = new Set(Object.keys(map));
const news = new Set(Object.values(map).map((v) => v.slice("/_blob/".length)));
const chained = [...news].filter((id) => olds.has(id)).sort();
if (chained.length > 0) die(`the map uses an old id as a new one: ${chained.join(", ")}`);

// First pass: check every file and compute its new text; nothing is written if one fails.
const counts = new Map([...olds].map((id) => [id, 0]));
const changes = [];
const texts = textFiles(root);
for (const file of texts) {
  const text = readFileSync(file, "utf8");
  const unknown = [...new Set([...text.matchAll(BLOB)].map((m) => m[1]))]
    .filter((id) => !olds.has(id) && !news.has(id))
    .sort();
  if (unknown.length > 0) die(`${file} cites assets that are not in the map: ${unknown.join(", ")}`);
  const next = text.replace(BLOB, (match, id) => {
    if (!olds.has(id)) return match;
    counts.set(id, counts.get(id) + 1);
    return map[id];
  });
  if (next !== text) changes.push([file, next]);
}

if (args.values.manifest) {
  const manifest = readJson(args.values.manifest, "manifest");
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const problems = [];
  for (const a of assets) {
    if (!olds.has(a.id)) problems.push(`${a.id} has no mapping`);
    else if (counts.get(a.id) !== a.references)
      problems.push(`${a.id}: ${counts.get(a.id)} replacements, the manifest expects ${a.references}`);
  }
  const known = new Set(assets.map((a) => a.id));
  for (const id of olds) if (!known.has(id)) problems.push(`${id} is not an asset of the manifest`);
  if (problems.length > 0) die(`the counts do not match the manifest:\n  ${problems.join("\n  ")}`);
}

for (const [file, next] of changes) writeFileSync(file, next);

const left = texts.filter((file) => [...readFileSync(file, "utf8").matchAll(BLOB)].some((m) => olds.has(m[1])));
if (left.length > 0) die(`old references are still there in: ${left.join(", ")}`);

for (const [old, n] of counts) process.stdout.write(`${old} -> ${map[old]}: ${n} replacements\n`);
