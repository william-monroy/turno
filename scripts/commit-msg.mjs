#!/usr/bin/env node
// Commit message rules (Conventional Commits, no attribution trailers, no em dash).
//   node scripts/commit-msg.mjs <file>        the git commit-msg hook (pnpm hooks installs it)
//   node scripts/commit-msg.mjs --title "..."  a pull request title, in CI
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`);
const TRAILERS = [/^co-authored-by:/i, /^assisted-by:/i, /^claude-session:/i, /generated with/i];
const EM_DASH = String.fromCharCode(0x2014);

/** Problems with a commit message or title; empty when it is fine. */
export function checkMessage(text) {
  const lines = text.split("\n").filter((l) => !l.startsWith("#"));
  const subject = (lines[0] ?? "").trim();
  if (/^(Merge|Revert) /.test(subject)) return [];
  const problems = [];
  if (!SUBJECT.test(subject)) {
    problems.push(`the subject must be "type(scope): summary" with type one of ${TYPES.join(", ")}: "${subject}"`);
  }
  for (const line of lines) {
    if (TRAILERS.some((re) => re.test(line.trim()))) {
      problems.push(`no attribution lines for tools (see AI_POLICY.md): "${line.trim()}"`);
    }
  }
  if (lines.join("\n").includes(EM_DASH)) problems.push("no em dash (U+2014); use a colon, comma or parentheses");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, value] = process.argv.slice(2);
  const text = flag === "--title" ? (value ?? "") : readFileSync(flag, "utf8");
  const problems = checkMessage(text);
  for (const p of problems) console.error(`commit-msg: ${p}`);
  process.exit(problems.length ? 1 : 0);
}
