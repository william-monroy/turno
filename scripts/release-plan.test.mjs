import assert from "node:assert/strict";
import { test } from "node:test";
import { publishOrder } from "./release-plan.mjs";

const pkg = (dir, name, dependencies = {}, extra = {}) => ({ dir, manifest: { name, version: "1.0.0", dependencies, ...extra } });

test("publishes a workspace package before the packages that depend on it", () => {
  const order = publishOrder([
    pkg("browser", "turno-browser", { "turno-core": "workspace:*", "patchright-core": "1.64.3" }),
    pkg("core", "turno-core"),
    pkg("fonts", "turno-fonts"),
    pkg("turno", "turno-cli", { "turno-core": "workspace:*" }, { devDependencies: { "turno-browser": "workspace:*" } }),
  ]);
  assert.deepEqual(order, ["core", "browser", "fonts", "turno"]);
});

test("refuses a dependency cycle", () => {
  assert.throws(() => publishOrder([pkg("a", "a", { b: "workspace:*" }), pkg("b", "b", { a: "workspace:*" })]), /cycle: a -> b -> a/);
});
