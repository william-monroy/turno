#!/usr/bin/env node
// Copies the images the site shows from docs/assets into public/, so the repository keeps one
// copy of each (the README uses the same files). Runs before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(APP, "../../docs/assets");
mkdirSync(join(APP, "public"), { recursive: true });
for (const name of ["icon.svg", "demo.gif", "statusline.png", "social-preview.png"]) {
  copyFileSync(join(ASSETS, name), join(APP, "public", name));
}
