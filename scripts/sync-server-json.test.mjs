import assert from "node:assert/strict";
import { test } from "node:test";
import { syncServerJson } from "./sync-server-json.mjs";

const server = {
  name: "io.github.wimo-dev/turno-browser",
  version: "0.1.0",
  packages: [{ registryType: "npm", identifier: "turno-browser", version: "0.1.0" }],
};

test("copies the package version into server.json", () => {
  const out = syncServerJson(server, { name: "turno-browser", version: "0.2.0", mcpName: server.name });
  assert.equal(out.version, "0.2.0");
  assert.equal(out.packages[0].version, "0.2.0");
  assert.equal(server.version, "0.1.0", "does not mutate its input");
});

test("refuses a server name that differs from mcpName", () => {
  assert.throws(
    () =>
      syncServerJson(server, { name: "turno-browser", version: "0.2.0", mcpName: "io.github.someone/turno-browser" }),
    /mcpName/,
  );
});
