// Fails when any tracked text file contains an em dash (U+2014). Project rule.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM_DASH = String.fromCharCode(0x2014);
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
}).split("\n").filter(Boolean);
const bad = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes(EM_DASH)) bad.push(file);
}
if (bad.length) {
  console.error(`em dash found in:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
