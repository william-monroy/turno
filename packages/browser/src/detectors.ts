/**
 * Pure parsers for the bench targets. They take page HTML (as returned by `page.content()`)
 * and never touch the network, so tests run them on saved snippets.
 */

export type TestStatus = "pass" | "fail" | "warn" | "untriggered";

export interface DetectorTest {
  name: string;
  status: TestStatus;
  note: string;
}

export interface RebrowserResult {
  tests: DetectorTest[];
  passed: number;
  failed: number;
  warned: number;
  untriggered: number;
}

export interface SannysoftResult {
  rows: { name: string; status: "pass" | "fail" }[];
  passed: number;
  failed: number;
  failedNames: string[];
}

export interface ChallengeResult {
  title: string;
  markers: string[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Drops comments, scripts, styles and templates: markup that is never shown as text. */
export function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

/** Visible-ish text of an HTML fragment, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(stripInvisible(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function rowsOf(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) => m[1]!);
}

function cellsOf(rowHtml: string): { attrs: string; inner: string }[] {
  return [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td\s*>/gi)].map((m) => ({ attrs: m[1]!, inner: m[2]! }));
}

const STATUS_BY_MARK: [string, TestStatus][] = [
  ["\u{1F7E2}", "pass"], // green circle
  ["\u{1F534}", "fail"], // red circle
  ["\u{1F7E1}", "warn"], // yellow circle
  ["⚪", "untriggered"], // white circle
];

/** Parses the result table of https://bot-detector.rebrowser.net/. */
export function parseRebrowser(html: string): RebrowserResult {
  const start = html.search(/<table\b[^>]*id=["']detections-table["']/i);
  const tests: DetectorTest[] = [];
  if (start >= 0) {
    const end = html.indexOf("</table", start);
    const table = html.slice(start, end < 0 ? undefined : end);
    for (const row of rowsOf(table)) {
      const cells = cellsOf(row);
      if (cells.length < 1) continue;
      const label = textOf(cells[0]!.inner);
      const mark = STATUS_BY_MARK.find(([m]) => label.startsWith(m));
      if (!mark) continue;
      const name = label.slice(mark[0].length).replace(/^️/, "").trim();
      const notesHtml = (cells[2]?.inner ?? "").replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, " ");
      const note = textOf(notesHtml).replace(/^[\u{1F534}\u{1F7E1}\u{1F7E2}⚪]️?\s*/u, "");
      tests.push({ name, status: mark[1], note: note.length > 200 ? `${note.slice(0, 197)}...` : note });
    }
  }
  const count = (s: TestStatus) => tests.filter((t) => t.status === s).length;
  return { tests, passed: count("pass"), failed: count("fail"), warned: count("warn"), untriggered: count("untriggered") };
}

/** Counts the passed and failed rows of https://bot.sannysoft.com/. */
export function parseSannysoft(html: string): SannysoftResult {
  const rows: SannysoftResult["rows"] = [];
  for (const row of rowsOf(stripInvisible(html))) {
    const cells = cellsOf(row);
    if (cells.length < 2) continue;
    let status: "pass" | "fail" | undefined;
    for (const cell of cells.slice(1)) {
      const cls = /\bclass=["']([^"']*)["']/i.exec(cell.attrs)?.[1] ?? "";
      const words = cls.split(/\s+/);
      if (words.includes("failed")) status = "fail";
      else if (words.includes("passed") && status === undefined) status = "pass";
    }
    if (status) rows.push({ name: textOf(cells[0]!.inner), status });
  }
  const failedNames = rows.filter((r) => r.status === "fail").map((r) => r.name);
  return { rows, passed: rows.length - failedNames.length, failed: failedNames.length, failedNames };
}

/** Phrases that show a bot wall instead of the page. Matched on visible text and the title. */
export const CHALLENGE_MARKERS = [
  "captcha",
  "verify you are human",
  "are you a robot",
  "access denied",
  "unusual traffic",
  "checking your browser",
  "just a moment",
  "attention required",
  "request blocked",
];

export function titleOf(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? textOf(m[1]!) : "";
}

/** Looks for challenge phrases in the page's visible text and title (not in scripts). */
export function detectChallenge(html: string): ChallengeResult {
  const title = titleOf(html);
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
  const text = `${title} ${textOf(body)}`.toLowerCase();
  return { title, markers: CHALLENGE_MARKERS.filter((m) => text.includes(m)) };
}
