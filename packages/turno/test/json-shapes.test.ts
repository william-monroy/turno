import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSON_MCP_SERVERS } from "../src/agents/adapter.js";
import { CliError } from "../src/cli/io.js";
import { isObject, parseJsonObject } from "../src/core/fsutil.js";
import { syncServers } from "../src/mcpd/sync.js";
import { currentStatusLine, readSettings } from "../src/ui/settings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("JSON files other programs write (H15)", () => {
  it("parseJsonObject accepts objects only and names the file", () => {
    expect(parseJsonObject('{"a":1}', "f.json")).toEqual({ a: 1 });
    for (const text of ["[]", "null", "3", '"x"']) {
      expect(() => parseJsonObject(text, "f.json")).toThrow(CliError);
      expect(() => parseJsonObject(text, "f.json")).toThrow(/f\.json does not hold a JSON object/);
    }
    expect(() => parseJsonObject("{", "f.json")).toThrow(SyntaxError);
    expect([isObject({}), isObject([]), isObject(null), isObject("x")]).toEqual([true, false, false, false]);
  });

  it("mcp sync refuses a config of the wrong shape instead of rewriting it", () => {
    const list = sb.write(".claude-p1/.claude.json", "[1,2]");
    expect(() => syncServers(list, JSON_MCP_SERVERS, { a: { url: "u" } }, [])).toThrow(/does not hold a JSON object/);
    expect(readFileSync(list, "utf8")).toBe("[1,2]");

    const text = '{"mcpServers":"oops"}';
    const bad = sb.write(".claude-p2/.claude.json", text);
    expect(() => syncServers(bad, JSON_MCP_SERVERS, { a: { url: "u" } }, [])).toThrow(/mcpServers is not a JSON object/);
    expect(readFileSync(bad, "utf8")).toBe(text);
  });

  it("settings.json of another shape is an error, and the status line reader stays quiet", () => {
    const file = sb.write(".claude/settings.json", "null");
    expect(() => readSettings(file)).toThrow(/does not hold a JSON object/);
    expect(currentStatusLine(file)).toBeUndefined();
  });
});
