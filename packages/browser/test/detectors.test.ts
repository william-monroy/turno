import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatBenchTable } from "../src/bench.js";
import { decodeEntities, detectChallenge, parseRebrowser, parseSannysoft, textOf } from "../src/detectors.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseRebrowser", () => {
  const r = parseRebrowser(fixture("rebrowser.html"));

  it("reads every row with its status", () => {
    expect(r.tests.map((t) => [t.name, t.status])).toEqual([
      ["dummyFn", "untriggered"],
      ["runtimeEnableLeak", "pass"],
      ["viewport", "warn"],
      ["navigatorWebdriver", "pass"],
      ["headless", "fail"],
      ["storagePartitioning", "fail"],
    ]);
    expect([r.passed, r.failed, r.warned, r.untriggered]).toEqual([2, 2, 1, 1]);
  });

  it("keeps notes short, without the JSON blocks or leading marks", () => {
    expect(r.tests.find((t) => t.name === "viewport")!.note).toBe("Viewport has default Playwright values. Use viewport: null in options.");
    expect(r.tests.find((t) => t.name === "headless")!.note).toBe("HeadlessChrome is in the user agent or navigator.userAgentData.brands.");
    expect(r.tests.find((t) => t.name === "storagePartitioning")!.note).toContain("page's localStorage");
  });

  it("returns nothing when the table is missing", () => {
    expect(parseRebrowser("<html><body>loading</body></html>").tests).toEqual([]);
  });
});

describe("parseSannysoft", () => {
  it("counts failed rows across both tables and ignores scripts", () => {
    const r = parseSannysoft(fixture("sannysoft.html"));
    expect(r.failed).toBe(3);
    expect(r.passed).toBe(4);
    expect(r.failedNames).toEqual(["User Agent (Old)", "HEADCHR_UA", "CHR_MEMORY"]);
  });
});

describe("detectChallenge", () => {
  it("finds challenge phrases in the title and visible text", () => {
    const c = detectChallenge(fixture("challenge.html"));
    expect(c.title).toBe("Just a moment...");
    expect(c.markers).toEqual(["verify you are human", "unusual traffic", "just a moment"]);
  });

  it("ignores words that only appear in scripts and styles", () => {
    const c = detectChallenge(fixture("clean.html"));
    expect(c).toEqual({ title: "Student portal", markers: [] });
  });
});

describe("html helpers", () => {
  it("decodes entities and collapses whitespace", () => {
    expect(decodeEntities("a &amp; b &#39;c&#x27; &lt;d&gt;")).toBe("a & b 'c' <d>");
    expect(textOf("<p> one\n <b>two</b></p><!-- hidden -->")).toBe("one two");
  });
});

describe("formatBenchTable", () => {
  it("prints one row per result and per skipped engine", () => {
    const table = formatBenchTable({
      version: 1,
      startedAt: "",
      finishedAt: "",
      engines: [
        { engine: "chrome-headless", status: "ran" },
        { engine: "firefox", status: "skipped", reason: "camoufox-js is not installed" },
      ],
      results: [
        { engine: "chrome-headless", target: "rebrowser", url: "u", ok: false, summary: "17 pass, 1 fail (headless)" },
        { engine: "chrome-headless", target: "url", url: "https://example.com/", ok: true, summary: '200 "Example" no challenge markers' },
      ],
    });
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ENGINE\s+TARGET\s+RESULT\s+DETAILS$/);
    expect(lines[1]).toMatch(/chrome-headless\s+rebrowser\s+FAIL\s+17 pass, 1 fail \(headless\)/);
    expect(lines[2]).toMatch(/https:\/\/example\.com\/\s+PASS/);
    expect(lines[3]).toMatch(/firefox\s+-\s+SKIPPED\s+camoufox-js is not installed/);
  });
});
