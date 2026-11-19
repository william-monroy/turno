// Unit tests for the fingerprint checks, on synthetic probe reports: the input today's stock
// tools produce, and input shaped like a person's. Run by `pnpm check` (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyExpectations,
  checkReport,
  compareWithBaseline,
  consistencyChecks,
  diffStatic,
  pointerPath,
} from "./lib/checks.mjs";

const STATIC = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  platform: "MacIntel",
  languages: ["en-US", "en"],
  webdriver: false,
  webdriverOwnProperty: false,
  webdriverGetterNative: true,
  plugins: 5,
  uaData: { brands: ["Not-A.Brand 99", "Google Chrome 157", "Chromium 157"], mobile: false, platform: "macOS" },
  window: { innerWidth: 1200, innerHeight: 800, outerWidth: 1200, outerHeight: 900 },
  chrome: ["app", "csi", "loadTimes"],
  notification: "default",
  notificationQuery: "prompt",
  webgl: { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3)" },
  csp: "blocked",
  automationGlobals: [],
  globals: ["document", "window"],
};

const ev = (type, t, target, extra = {}) => ({ type, t, trusted: true, target, ...extra });
const at = (x, y) => ({ x, y, sx: x + 20, sy: y + 100 });

/** What the stock tools send today: one move to the exact center, no press time, instant keys. */
function stockEvents() {
  const events = [
    ev("pointerover", 100, "click-target", at(430, 448)),
    ev("pointermove", 100, "click-target", { ...at(430, 448), coalesced: 1 }),
    ev("pointerdown", 100.2, "click-target", at(430, 448)),
    ev("pointerup", 100.3, "click-target", at(430, 448)),
    ev("focusin", 200, "type-fast"),
    ev("input", 201, "type-fast", { inputType: "insertText", length: 11 }),
    ev("focusin", 300, "type-slow"),
  ];
  for (let i = 0; i < 5; i++) {
    events.push(ev("keydown", 301 + i * 2, "type-slow", { key: "char" }));
    events.push(ev("keyup", 302 + i * 2, "type-slow", { key: "char" }));
  }
  events.push(ev("scroll", 400, undefined, { scrollY: 1900 }));
  events.push(ev("pointerdown", 401, "far-button", at(200, 396)));
  return events;
}

/** Input shaped like a person's: a curved path, an off-center press, human key timing, wheel steps. */
function humanEvents() {
  const events = [];
  for (let i = 0; i < 20; i++)
    events.push(ev("pointermove", i * 16, "body", { ...at(100 + i * 16, 100 + i * i), coalesced: 2 }));
  events.push(ev("pointerover", 330, "click-target", at(412, 452)));
  events.push(ev("pointerdown", 480, "click-target", at(412, 452)));
  events.push(ev("pointerup", 560, "click-target", at(412, 452)));
  events.push(ev("focusin", 700, "type-fast"));
  for (let i = 0; i < 3; i++) events.push(ev("keydown", 710 + i * 150, "type-fast", { key: "char" }));
  events.push(ev("focusin", 1300, "type-slow"));
  for (let i = 0; i < 5; i++) {
    events.push(ev("keydown", 1400 + i * 180, "type-slow", { key: "char" }));
    events.push(ev("keyup", 1470 + i * 180, "type-slow", { key: "char" }));
  }
  for (let i = 0; i < 6; i++) events.push(ev("wheel", 2500 + i * 40, "body", { dy: 100, mode: 0 }));
  events.push(ev("pointerdown", 2900, "far-button", at(200, 396)));
  return events;
}

const BOXES = { "click-target": { x: 340, y: 420, w: 180, h: 56 } };
const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

test("today's stock input is reported as warnings, not failures", () => {
  const c = byId(checkReport({ static: STATIC, events: stockEvents(), boxes: BOXES, traps: [] }, { headed: true }));
  assert.equal(c.webdriver.status, "pass");
  assert.equal(c["events-trusted"].status, "pass");
  assert.equal(c["pointer-moves-before-click"].status, "warn");
  assert.equal(c["pointer-moves-before-click"].value, 1);
  assert.equal(c["click-at-center"].status, "warn");
  assert.equal(c["press-duration"].status, "warn");
  assert.equal(c["typing-key-events"].status, "info");
  assert.equal(c["typing-interval"].status, "warn");
  assert.equal(c["key-hold"].status, "warn");
  assert.equal(c["focus-before-keys"].status, "pass");
  assert.equal(c["scroll-steps"].status, "info");
  assert.equal(c["screen-offset"].status, "pass");
  assert.ok(!Object.values(c).some((x) => x.status === "fail"), JSON.stringify(c));
});

test("input shaped like a person's passes the event checks", () => {
  const c = byId(checkReport({ static: STATIC, events: humanEvents(), boxes: BOXES, traps: [] }, { headed: true }));
  for (const id of [
    "pointer-moves-before-click",
    "click-at-center",
    "press-duration",
    "hover-dwell",
    "coalesced-events",
    "typing-key-events",
    "typing-interval",
    "key-hold",
    "focus-before-keys",
    "scroll-steps",
  ]) {
    assert.equal(c[id].status, "pass", `${id}: ${JSON.stringify(c[id])}`);
  }
});

test("automation markers and contradictions fail", () => {
  const s = {
    ...STATIC,
    webdriver: true,
    userAgent: STATIC.userAgent.replace("Chrome/", "HeadlessChrome/"),
    uaData: { ...STATIC.uaData, platform: "Windows" },
    automationGlobals: ["__playwright__binding__"],
    notification: "denied",
    window: { innerWidth: 1280, innerHeight: 720, outerWidth: 0, outerHeight: 0 },
  };
  const events = stockEvents().map((e) => (e.type === "pointerdown" ? { ...e, trusted: false } : e));
  const c = byId(
    checkReport({ static: s, events, boxes: BOXES, traps: [], legacyRuntimeLeak: true }, { headed: true }),
  );
  for (const id of [
    "webdriver",
    "headless-token",
    "client-hints-match",
    "automation-globals",
    "notification-permission",
    "window-size",
    "legacy-runtime-leak",
    "events-trusted",
  ]) {
    assert.equal(c[id].status, "fail", id);
  }
});

test("the headless token is a warning headless and a failure headed", () => {
  const s = { ...STATIC, userAgent: STATIC.userAgent.replace("Chrome/", "HeadlessChrome/") };
  const report = { static: s, events: stockEvents(), boxes: BOXES, traps: [] };
  assert.equal(byId(checkReport(report, { headed: false }))["headless-token"].status, "warn");
  assert.equal(byId(checkReport(report, { headed: true }))["headless-token"].status, "fail");
});

test("main-world DOM calls and extra globals are warnings", () => {
  const report = {
    static: { ...STATIC, globals: ["document", "window", "__extra"] },
    events: stockEvents(),
    boxes: BOXES,
    traps: [{ api: "document.querySelector", stack: "at eval" }],
  };
  const c = byId(checkReport(report, { headed: true, reference: STATIC }));
  assert.equal(c["main-world-calls"].status, "warn");
  assert.equal(c["extra-globals"].status, "warn");
  assert.deepEqual(c["extra-globals"].value, ["__extra"]);
  assert.equal(c["matches-plain-chrome"].status, "pass");
});

test("fields that differ from plain Chrome are listed", () => {
  const diff = diffStatic({ ...STATIC, plugins: 0, languages: ["en-US"] }, STATIC);
  assert.deepEqual(
    diff.map((d) => d.field),
    ["languages", "plugins"],
  );
});

test("a configuration's expectations turn an unmet check into a failure", () => {
  const checks = [
    { id: "pointer-moves-before-click", status: "warn", note: "jumps" },
    { id: "typing-interval", status: "pass" },
  ];
  const out = applyExpectations(checks, { "pointer-moves-before-click": "pass", "typing-interval": "pass" });
  assert.equal(out[0].status, "fail");
  assert.match(out[0].note, /jumps; expected pass with this configuration/);
  assert.equal(out[1].status, "pass");
});

test("the pointer path measures moves, length and straightness", () => {
  const p = pointerPath(humanEvents(), "click-target");
  assert.equal(p.moves, 20);
  assert.ok(p.straightness > 1);
  assert.equal(pointerPath(stockEvents(), "click-target").moves, 1);
  assert.equal(pointerPath([], "click-target"), undefined);
});

test("a baseline comparison lists checks that got worse and fields that changed", () => {
  const old = {
    configs: [
      {
        name: "default",
        headed: true,
        static: STATIC,
        checks: [
          { id: "webdriver", status: "pass" },
          { id: "press-duration", status: "warn" },
        ],
      },
    ],
  };
  const now = {
    configs: [
      {
        name: "default",
        headed: true,
        static: { ...STATIC, userAgent: STATIC.userAgent.replace("157", "158") },
        checks: [
          { id: "webdriver", status: "fail" },
          { id: "press-duration", status: "pass" },
        ],
      },
    ],
  };
  const { regressions, changes } = compareWithBaseline(now, old);
  assert.deepEqual(regressions, [{ config: "default", check: "webdriver", from: "pass", to: "fail", note: undefined }]);
  assert.deepEqual(
    changes.map((c) => c.field),
    ["userAgent"],
  );
});

test("headers, a worker and the Intl locale that agree with the page pass the consistency checks", () => {
  const s = { ...STATIC, timezone: "Europe/Berlin", locale: "en-US" };
  const report = {
    static: s,
    request: {
      "user-agent": s.userAgent,
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
      "sec-ch-ua-platform": '"macOS"',
    },
    worker: {
      userAgent: s.userAgent,
      platform: s.platform,
      languages: s.languages,
      timezone: s.timezone,
      uaPlatform: "macOS",
    },
  };
  assert.deepEqual(
    consistencyChecks(report).map((c) => [c.id, c.status]),
    [
      ["headers-match-navigator", "pass"],
      ["worker-matches-page", "pass"],
      ["intl-matches-languages", "pass"],
    ],
  );
});

test("an override applied to one layer only shows up as a consistency warning", () => {
  const s = { ...STATIC, timezone: "Europe/Berlin", locale: "es-419" };
  const report = {
    static: s,
    request: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157.0.0.0",
      "sec-ch-ua-platform": '"macOS"',
    },
    worker: {
      userAgent: s.userAgent,
      platform: "Win32",
      languages: s.languages,
      timezone: "America/Mexico_City",
      uaPlatform: "macOS",
    },
  };
  const checks = Object.fromEntries(consistencyChecks(report).map((c) => [c.id, c]));
  assert.equal(checks["headers-match-navigator"].status, "warn");
  assert.deepEqual(checks["headers-match-navigator"].value, ["User-Agent"]);
  assert.deepEqual(checks["worker-matches-page"].value, ["platform", "timezone"]);
  assert.equal(checks["intl-matches-languages"].status, "warn");
  // Without headers or a worker report there is nothing to compare: info, not a warning.
  const bare = consistencyChecks({ static: STATIC });
  assert.deepEqual(
    bare.slice(0, 2).map((c) => c.status),
    ["info", "info"],
  );
});
