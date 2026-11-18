import { describe, expect, it } from "vitest";
import { type Diagnosis, explainFailure, failureMessage, isActionabilityFailure } from "../src/diagnose.js";

const TIMEOUT = `locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('aria-ref=e7')
  - <div class="cookie">...</div> intercepts pointer events`;

describe("isActionabilityFailure", () => {
  it("is true for the timeouts of an action and false for a stale ref or another error", () => {
    expect(isActionabilityFailure(TIMEOUT)).toBe(true);
    expect(isActionabilityFailure("element is not enabled")).toBe(true);
    expect(isActionabilityFailure("Ref e9 not found in the current page snapshot. Try capturing new snapshot.")).toBe(
      false,
    );
    expect(isActionabilityFailure("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
  });
});

describe("failureMessage", () => {
  const target = { role: "button", name: "Save", selector: "button#save" };

  it("names the element that covers the target and its buttons", () => {
    const d: Diagnosis = {
      state: "covered",
      target,
      cover: { role: "dialog", name: "We use cookies", selector: "div.cookie-banner" },
      buttons: ["Accept all", "Reject"],
    };
    const text = failureMessage("browser_click", "e7", d, TIMEOUT);
    expect(text).toBe(
      [
        'Could not click button "Save" (button#save), e7: dialog "We use cookies" (div.cookie-banner) covers it and would get the click instead.',
        'Next: close or answer that element first (it has "Accept all", "Reject"), then try again; take a new snapshot if the page changed.',
        "Playwright: locator.click: Timeout 5000ms exceeded.",
      ].join("\n"),
    );
  });

  it("says when the target is hidden, by what, disabled, read-only or gone", () => {
    expect(
      failureMessage(
        "browser_click",
        "e7",
        { state: "hidden", target, because: { role: "navigation", name: "Menu", selector: "nav.menu" } },
        TIMEOUT,
      ),
    ).toContain(
      'it is not visible (navigation "Menu" (nav.menu) hides it).\nNext: open the menu, tab or section that holds it',
    );
    expect(
      failureMessage(
        "browser_type",
        "#email",
        { state: "disabled", target: { role: "textbox", name: "Email", selector: "input#email" } },
        TIMEOUT,
      ),
    ).toMatch(
      /^Could not type into textbox "Email" \(input#email\), #email: it is disabled\.\nNext: do what enables it first/,
    );
    expect(failureMessage("browser_type", "e2", { state: "readonly", target }, TIMEOUT)).toContain("it is read-only.");
    expect(failureMessage("browser_hover", "e2", undefined, TIMEOUT)).toMatch(
      /^Could not hover over e2: the element is no longer on the page\.\nNext: take a new snapshot/,
    );
  });
});

describe("explainFailure", () => {
  const result = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

  it("leaves successes, other tools, other errors and calls without a page alone", async () => {
    const ok = { content: [{ type: "text" as const, text: "### Result\nok" }] };
    expect(
      await explainFailure(undefined, "browser_click", { target: "e7" }, result(`### Error\n${TIMEOUT}`), false),
    ).toEqual(result(`### Error\n${TIMEOUT}`));
    const page = {} as never;
    expect(await explainFailure(page, "browser_click", { target: "e7" }, ok, false)).toBe(ok);
    const nav = result("### Error\nnet::ERR_NAME_NOT_RESOLVED");
    expect(await explainFailure(page, "browser_navigate", { url: "x" }, nav, false)).toBe(nav);
    const stale = result("### Error\nRef e9 not found in the current page snapshot. Try capturing new snapshot.");
    expect(await explainFailure(page, "browser_click", { target: "e9" }, stale, false)).toBe(stale);
  });
});
