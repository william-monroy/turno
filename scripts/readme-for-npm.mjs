#!/usr/bin/env node
// Copies the root README into a package for npm, turning relative links into GitHub URLs,
// because npmjs.com cannot resolve paths inside the repository.
//   node scripts/readme-for-npm.mjs <out-file>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "wimo-dev/turno";
const BLOB = `https://github.com/${REPO}/blob/main/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const IMAGE = /\.(png|gif|svg|jpe?g|webp)$/i;

export function absolutize(md) {
  const fix = (url) => {
    if (/^(https?:|mailto:|#)/.test(url)) return url;
    const clean = url.replace(/^\.\//, "");
    return (IMAGE.test(clean.split("#")[0]) ? RAW : BLOB) + clean;
  };
  return md
    .replace(/\]\(([^)\s]+)\)/g, (_, u) => `](${fix(u)})`)
    .replace(/\b(src|srcset|href)="([^"]+)"/g, (_, a, u) => `${a}="${fix(u)}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: readme-for-npm.mjs <out-file>");
  writeFileSync(out, absolutize(readFileSync(join(ROOT, "README.md"), "utf8")));
}
