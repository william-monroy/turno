import { describe, expect, it } from "vitest";
import { ENGINES, ENGINE_ALIASES, defaultEngines, engineId } from "../src/bench.js";

describe("engine ids", () => {
  it("names engines by browser and mode, not by the library behind them", () => {
    expect([...ENGINES]).toEqual(["chrome-headed", "chrome-headless", "chrome-baseline", "firefox"]);
    for (const e of ENGINES) expect(e).not.toMatch(/patchright|camoufox|stealth|stock/i);
  });

  it("still accepts the old ids, so scripts keep working", () => {
    expect(engineId("patchright-chrome-headed")).toBe("chrome-headed");
    expect(engineId("patchright-chrome-headless")).toBe("chrome-headless");
    expect(engineId("playwright-stock")).toBe("chrome-baseline");
    expect(engineId("camoufox")).toBe("firefox");
    expect(Object.values(ENGINE_ALIASES).every((e) => (ENGINES as readonly string[]).includes(e))).toBe(true);
  });

  it("takes the new ids as they are and refuses unknown ones", () => {
    for (const e of ENGINES) expect(engineId(e)).toBe(e);
    expect(engineId("nope")).toBeUndefined();
    expect(engineId("toString")).toBeUndefined();
  });

  it("runs both Chrome engines by default", () => {
    expect(defaultEngines().slice(0, 2)).toEqual(["chrome-headed", "chrome-headless"]);
  });
});
