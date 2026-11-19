import { names } from "./names.js";
/**
 * The live view page: one HTML document with its style and script inline, allowed by a nonce
 * in the Content-Security-Policy. It reads the server's events (`/events`: the state and the
 * frames of the tab it shows), and posts Pause, Resume, the tab to show and, while the agent is
 * paused, the user's clicks, keys and scrolls. Text from pages (titles, URLs) only ever goes into
 * `textContent`, never into HTML.
 */

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1c1c1a; --muted: #6b6b66; --line: #d9d9d4; --accent: #2b5fd9; --warn: #b4561a; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a94; --line: #34342f; --accent: #7aa2ff; --warn: #f0a060; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
header strong { font-weight: 600; }
#status { color: var(--muted); flex: 1 1 200px; }
#status.paused { color: var(--warn); }
button { font: inherit; padding: 4px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
button.on { border-color: var(--accent); color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
nav button { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
main { padding: 12px 16px; }
#notice { color: var(--warn); margin-bottom: 8px; min-height: 1.4em; }
#frame { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); outline: none; }
#frame:focus { border-color: var(--accent); }
#frame:not([src]) { display: none; }
footer { padding: 0 16px 16px; color: var(--muted); font-size: 13px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const frame = $("frame");
let state = null;
let size = { w: 0, h: 0 };
function note(text) { $("notice").textContent = text || ""; }
async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-turno-live": "1" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (data.error) note(data.error);
    else if (data.identity) render(data);
  } catch (error) { note(String(error)); }
}
function render(s) {
  state = s;
  $("id").textContent = s.identity;
  const status = $("status");
  status.className = s.paused ? "paused" : "";
  status.textContent = s.paused
    ? "Paused (" + s.paused.by + "). " + (s.waiting ? s.waiting + " agent call" + (s.waiting === 1 ? " is" : "s are") + " waiting. " : "") + (s.busy ? "A call that started before the pause is still running." : "You have the controls.")
    : (s.busy ? "The agent is working." : "The agent is idle.") + (s.browser ? "" : " The browser is not running.");
  $("pause").disabled = !!s.paused;
  $("resume").disabled = !s.paused;
  const tabs = $("tabs");
  tabs.replaceChildren();
  const follow = document.createElement("button");
  follow.textContent = "Follow the agent";
  follow.className = s.pinned ? "" : "on";
  follow.onclick = () => post("/follow", { tab: null });
  tabs.append(follow);
  for (const t of s.tabs) {
    const b = document.createElement("button");
    b.textContent = (t.session ? "[" + t.session + "] " : "") + (t.title || t.url || "(blank)");
    b.title = t.url;
    b.className = t.id === s.showing ? "on" : "";
    b.onclick = () => post("/follow", { tab: t.id });
    tabs.append(b);
  }
  let why = "";
  if (!s.view.available) why = s.view.reason;
  else if (s.hidden) why = "Hidden: this page holds a vault or sensitive value. It shows again after the page navigates.";
  else if (!s.browser) why = "Nothing to show until the agent opens the browser.";
  if (why) frame.removeAttribute("src");
  note(why);
  $("help").textContent = s.view.available
    ? (s.paused ? "Click, scroll and type on the picture to act on the page. Resume when you are done; the agent is told what changed." : "Pause to take the controls: the agent's next call waits until you resume (up to " + Math.round(s.wait / 1000) + " s per call).")
    : "Pause and resume still work: the agent's next call waits until you resume.";
}
const events = new EventSource("/events");
events.addEventListener("state", (e) => render(JSON.parse(e.data)));
events.addEventListener("frame", (e) => {
  const f = JSON.parse(e.data);
  if (!state || !state.view.available || state.hidden) return;
  size = { w: f.w, h: f.h };
  frame.src = "data:image/jpeg;base64," + f.data;
});
events.onerror = () => { $("status").textContent = "Disconnected: the server stopped or restarted. Open the view again with turno-browser live."; };
$("pause").onclick = () => post("/pause");
$("resume").onclick = () => post("/resume");
function point(e) {
  const r = frame.getBoundingClientRect();
  return { x: Math.round(((e.clientX - r.left) * size.w) / r.width), y: Math.round(((e.clientY - r.top) * size.h) / r.height) };
}
function canAct() {
  if (state && state.paused) return true;
  note("Pause first: your input goes to the page only while the agent waits.");
  return false;
}
frame.addEventListener("click", (e) => { frame.focus(); if (canAct()) post("/input", { type: "click", ...point(e) }); });
frame.addEventListener("dblclick", (e) => { if (canAct()) post("/input", { type: "dblclick", ...point(e) }); });
let wheel = null;
frame.addEventListener("wheel", (e) => {
  if (!state || !state.paused) return;
  e.preventDefault();
  if (wheel) { wheel.dx += e.deltaX; wheel.dy += e.deltaY; return; }
  wheel = { type: "wheel", ...point(e), dx: e.deltaX, dy: e.deltaY };
  setTimeout(() => { const w = wheel; wheel = null; post("/input", { ...w, dx: Math.round(w.dx), dy: Math.round(w.dy) }); }, 80);
}, { passive: false });
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
frame.addEventListener("keydown", (e) => {
  if (!state || !state.paused || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) { e.preventDefault(); post("/input", { type: "text", text: e.key }); }
  else if (KEYS.has(e.key)) { e.preventDefault(); post("/input", { type: "key", key: e.key }); }
});
`;

/** The page, with the nonce the response's Content-Security-Policy allows. */
export function livePage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>turno live view</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header><strong>turno live</strong><span id="id"></span><span id="status">Connecting...</span><button id="pause" type="button">Pause</button><button id="resume" type="button" disabled>Resume</button></header>
<nav id="tabs" aria-label="Tabs"></nav>
<main><div id="notice" role="status"></div><img id="frame" alt="The agent's tab" tabindex="0"></main>
<footer id="help"></footer>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}

/** What a browser without the view's cookie sees. */
export function deniedPage(identity: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>turno live view</title></head>
<body><p>This live view needs a fresh link. Run <code>${names().browser} live ${identity}</code>: it opens one that works once.</p></body></html>
`;
}
