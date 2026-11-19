// The local pages the evaluation tasks run on, served on 127.0.0.1 (and on localhost, a second
// origin for cross-origin frames). Pages report what the user did by POSTing to /submit/<task>,
// so a task's check reads what the site received instead of trusting what the agent says.

import { createServer } from "node:http";

const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;margin:24px;max-width:720px} label{display:block;margin:8px 0}</style>
</head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const submit = (task, expr) => `fetch('/submit/${task}', { method: 'POST', body: JSON.stringify(${expr}) })`;

/** The value shown on report page `i` of the many-tabs task. */
export const reportValue = (i) => ((i * 7) % 11) + 3;

/** Number of report pages in the many-tabs task. */
export const REPORTS = 10;

/** The price of catalog product `i`, in cents. */
export const productPrice = (i) => 1000 + ((i * 7919) % 9000);

/** Rows in the catalog page. */
export const PRODUCTS = 400;

const PAGES = {
  "/blank": () => page("Ready", "<p>Ready</p>"),
  "/form": () =>
    page(
      "Create your account",
      `<main><h1>Create your account</h1>
<form id="f">
  <label>Full name <input name="name" autocomplete="off"></label>
  <label>Email <input name="email" type="email" autocomplete="off"></label>
  <label>Plan <select name="plan"><option value="free">Free</option><option value="team">Team</option><option value="pro">Pro</option></select></label>
  <fieldset><legend>Contact me by</legend>
    <label><input type="radio" name="contact" value="email"> Email</label>
    <label><input type="radio" name="contact" value="phone"> Phone</label>
  </fieldset>
  <label><input type="checkbox" name="terms"> I accept the terms</label>
  <button>Create account</button>
</form>
<p id="out" role="status"></p></main>`,
      `const f = document.getElementById('f'), out = document.getElementById('out');
f.onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  d.terms = f.terms.checked;
  if (!d.terms) { out.textContent = 'Accept the terms first'; return; }
  const r = await ${submit("form", "d")};
  out.textContent = r.ok ? 'Account created for ' + d.name : 'Something went wrong';
};`,
    ),

  "/popup": () =>
    page(
      "Integrations",
      `<h1>Integrations</h1><p>Connect the calendar to import events.</p>
<button id="connect">Connect calendar</button><p id="out" role="status">Not connected</p>`,
      `document.getElementById('connect').onclick = () => window.open('/popup/authorize', 'authorize', 'width=480,height=560');
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || e.data !== 'allowed') return;
  await ${submit("popup", "{ connected: true }")};
  document.getElementById('out').textContent = 'Calendar connected';
});`,
    ),
  "/popup/authorize": () =>
    page(
      "Authorize access",
      `<h1>Authorize access</h1><p>The calendar app wants to read your events.</p>
<button id="deny">Deny</button> <button id="allow">Allow</button>`,
      `document.getElementById('allow').onclick = () => { window.opener.postMessage('allowed', location.origin); setTimeout(() => window.close(), 50); };
document.getElementById('deny').onclick = () => window.close();`,
    ),

  "/overlay": () =>
    page(
      "Quarterly report",
      `<h1>Quarterly report</h1><p>Revenue grew in every region.</p>
<button id="download">Download report</button><p id="out" role="status"></p>
<div id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10;display:flex;align-items:end">
  <div role="dialog" aria-label="Cookie preferences" style="background:#fff;padding:16px;width:100%">
    <p>We use cookies to remember your preferences.</p>
    <button id="reject">Reject all</button> <button id="accept">Accept all</button>
  </div>
</div>`,
      `document.getElementById('accept').onclick = () => document.getElementById('consent').remove();
document.getElementById('reject').onclick = () => document.getElementById('consent').remove();
document.getElementById('download').onclick = async () => {
  await ${submit("overlay", "{ downloaded: true }")};
  document.getElementById('out').textContent = 'Download started';
};`,
    ),

  "/slow": () =>
    page(
      "Checkout",
      `<h1>Checkout</h1><p id="total">Loading your order...</p>
<button id="confirm" disabled>Confirm order</button><p id="out" role="status"></p>`,
      `fetch('/api/slow-order').then((r) => r.json()).then((o) => {
  document.getElementById('total').textContent = 'Order total: ' + o.total;
  document.getElementById('confirm').disabled = false;
});
document.getElementById('confirm').onclick = async () => {
  await ${submit("slow", "{ confirmed: true }")};
  document.getElementById('out').textContent = 'Order confirmed';
};`,
    ),

  "/tabs": () =>
    page(
      "Monthly reports",
      `<h1>Monthly reports</h1><p>Open every report and add up their values.</p>
<ul>${Array.from({ length: REPORTS }, (_, i) => `<li><a href="/tabs/report/${i + 1}" target="_blank">Report ${i + 1}</a></li>`).join("")}</ul>
<form id="f"><label>Total <input name="total" autocomplete="off"></label><button>Submit total</button></form>
<p id="out" role="status"></p>`,
      `const f = document.getElementById('f');
f.onsubmit = async (e) => {
  e.preventDefault();
  await ${submit("tabs", "{ total: Number(f.total.value) }")};
  document.getElementById('out').textContent = 'Total received';
};`,
    ),

  "/shadow": () =>
    page(
      "Your cart",
      `<h1>Your cart</h1><p>One item, 3 seats.</p><checkout-panel></checkout-panel><p id="out" role="status"></p>`,
      `customElements.define('promo-field', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label>Promo code <input autocomplete="off"></label> <button>Apply code</button>';
    root.querySelector('button').onclick = () => this.dispatchEvent(new CustomEvent('apply', { bubbles: true, composed: true, detail: root.querySelector('input').value }));
  }
});
customElements.define('checkout-panel', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<section><h2>Discounts</h2><promo-field></promo-field></section>';
  }
});
document.addEventListener('apply', async (e) => {
  await ${submit("shadow", "{ code: e.detail }")};
  document.getElementById('out').textContent = 'Code applied: ' + e.detail;
});`,
    ),

  "/frames": (site) =>
    page(
      "Payment",
      `<h1>Payment</h1>
<iframe src="/frames/holder" title="Card holder" width="600" height="140"></iframe>
<iframe src="${site.altUrl}/frames/pay" title="Payment provider" width="600" height="140"></iframe>`,
    ),
  "/frames/holder": () =>
    page(
      "Card holder",
      `<form id="f"><label>Name on card <input name="holder" autocomplete="off"></label><button>Save name</button></form><p id="out" role="status"></p>`,
      `const f = document.getElementById('f');
f.onsubmit = async (e) => {
  e.preventDefault();
  await ${submit("frames-holder", "{ holder: f.holder.value }")};
  document.getElementById('out').textContent = 'Name saved';
};`,
    ),
  "/frames/pay": () =>
    page(
      "Payment provider",
      `<p>Amount due: $49.00</p><button id="pay">Pay now</button><p id="out" role="status"></p>`,
      `document.getElementById('pay').onclick = async () => {
  await ${submit("frames-pay", "{ paid: true }")};
  document.getElementById('out').textContent = 'Payment sent';
};`,
    ),

  "/dialog": () =>
    page(
      "Drafts",
      `<h1>Drafts</h1><p>Draft: Launch announcement</p><button id="delete">Delete draft</button><p id="out" role="status"></p>`,
      `document.getElementById('delete').onclick = async () => {
  if (!confirm('Delete this draft? This cannot be undone.')) return;
  await ${submit("dialog", "{ deleted: true }")};
  document.getElementById('out').textContent = 'Draft deleted';
};`,
    ),

  "/catalog": () =>
    page(
      "Catalog",
      `<h1>Catalog</h1><table><thead><tr><th>Product</th><th>Price</th><th></th></tr></thead><tbody>${Array.from(
        { length: PRODUCTS },
        (_, i) =>
          `<tr><td>Product ${i + 1}</td><td>$${(productPrice(i + 1) / 100).toFixed(2)}</td><td><button>Add to cart</button></td></tr>`,
      ).join("")}</tbody></table>`,
    ),
};

function reportPage(i) {
  return page(`Report ${i}`, `<h1>Report ${i}</h1><p>Value: ${reportValue(i)}</p>`);
}

/**
 * Starts the site. `submissions` holds the last body each task's page posted. Every page is
 * fresh per site, and a site serves one run, so runs never see each other's state.
 */
export async function startSite() {
  const submissions = {};
  const site = { url: "", altUrl: "", submissions };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && path.startsWith("/submit/")) {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        try {
          submissions[path.slice("/submit/".length)] = JSON.parse(body || "null");
        } catch {
          submissions[path.slice("/submit/".length)] = { invalid: body.slice(0, 200) };
        }
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
      return;
    }
    if (path === "/api/slow-order") {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ total: "$1,234.56" }));
      }, 1500);
      return;
    }
    const report = /^\/tabs\/report\/(\d+)$/.exec(path);
    const html = report ? reportPage(Number(report[1])) : PAGES[path]?.(site);
    if (!html) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const send = () => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    };
    // The slow page's document itself takes a while, as on a busy server.
    if (path === "/slow") setTimeout(send, 800);
    else send();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  site.url = `http://127.0.0.1:${port}`;
  site.altUrl = `http://localhost:${port}`;
  return {
    ...site,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
