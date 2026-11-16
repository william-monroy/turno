import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildShrinkwrap,
  collectGraph,
  inexactDependencies,
  installScripts,
  layout,
  lockIntegrity,
  resolveIn,
  shrinkwrapProblems,
} from "./shrinkwrap.mjs";

test("reads integrity from both documents of a pnpm v9 lockfile", () => {
  const text = [
    "---",
    "packages:",
    "",
    "  '@scope/a@1.0.0':",
    "    resolution: {integrity: sha512-AAA==}",
    "    engines: {node: '>=18'}",
    "",
    "  b@2.0.0:",
    "    resolution: {integrity: sha512-BBB==}",
    "",
  ].join("\n");
  const m = lockIntegrity(text);
  assert.equal(m.get("@scope/a@1.0.0"), "sha512-AAA==");
  assert.equal(m.get("b@2.0.0"), "sha512-BBB==");
});

test("lays packages out like npm: hoisted, nested only on a version conflict", () => {
  // root -> a, b; a -> c@1; b -> c@2; c@2 -> d; c@1 -> d
  const edges = {
    "a@1": new Map([["c", "c@1"]]),
    "b@1": new Map([["c", "c@2"]]),
    "c@1": new Map([["d", "d@1"]]),
    "c@2": new Map([["d", "d@1"]]),
    "d@1": new Map(),
  };
  const placed = layout(new Map([["a", "a@1"], ["b", "b@1"]]), (k) => edges[k]);
  assert.deepEqual(Object.fromEntries(placed), {
    "node_modules/a": "a@1",
    "node_modules/b": "b@1",
    "node_modules/c": "c@1",
    "node_modules/b/node_modules/c": "c@2",
    "node_modules/d": "d@1",
  });
  // Every edge resolves, the way Node looks up node_modules, to the version it needs.
  for (const [path, key] of placed) {
    for (const [name, want] of edges[key]) assert.equal(placed.get(resolveIn(placed, path, name)), want, `${path} -> ${name}`);
  }
});

test("handles dependency cycles and scoped names", () => {
  const edges = { "@s/x@1": new Map([["y", "y@1"]]), "y@1": new Map([["@s/x", "@s/x@1"]]) };
  const placed = layout(new Map([["@s/x", "@s/x@1"]]), (k) => edges[k]);
  assert.deepEqual([...placed.keys()].sort(), ["node_modules/@s/x", "node_modules/y"]);
});

test("finds install scripts, including an implicit node-gyp build", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-test-"));
  try {
    assert.deepEqual(installScripts({ scripts: { postinstall: "x", prepack: "y" } }), ["postinstall"]);
    assert.deepEqual(installScripts({ scripts: { test: "x" } }, dir), []);
    writeFileSync(join(dir, "binding.gyp"), "{}");
    assert.deepEqual(installScripts({}, dir), ["install (binding.gyp)"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags dependencies that are not exact versions", () => {
  assert.deepEqual(inexactDependencies({ dependencies: { a: "1.2.3", b: "^1.0.0", c: "1.0.0-next.1" }, optionalDependencies: { d: "workspace:^" } }), [
    "dependencies.b: ^1.0.0",
    "optionalDependencies.d: workspace:^",
  ]);
});

/** A tiny pnpm-style install: the package links to a virtual store entry, which links its deps. */
function fakeInstall() {
  const base = mkdtempSync(join(tmpdir(), "sw-graph-"));
  const store = join(base, "node_modules", ".pnpm");
  const pkg = (key, name, manifest) => {
    const dir = join(store, key, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
    return dir;
  };
  const a = pkg("a@1.0.0", "a", { version: "1.0.0", dependencies: { b: "^2.0.0" }, license: "MIT" });
  const b = pkg("b@2.1.0", "b", { version: "2.1.0", scripts: { postinstall: "node x.js" } });
  symlinkSync(b, join(store, "a@1.0.0", "node_modules", "b"));
  const app = join(base, "packages", "app");
  mkdirSync(join(app, "node_modules"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: { a: "1.0.0" }, devDependencies: { z: "^1" } }));
  symlinkSync(a, join(app, "node_modules", "a"));
  return { base, app };
}

test("builds a shrinkwrap from the installed tree and the lockfile, and reports problems", () => {
  const { base, app } = fakeInstall();
  try {
    const graph = collectGraph(app);
    assert.deepEqual([...graph.nodes.keys()].sort(), ["a@1.0.0", "b@2.1.0"]);
    const integrity = new Map([
      ["a@1.0.0", "sha512-a"],
      ["b@2.1.0", "sha512-b"],
    ]);
    const sw = buildShrinkwrap(graph, integrity);
    assert.deepEqual(sw.packages[""], { name: "app", version: "0.1.0", dependencies: { a: "1.0.0" } });
    assert.equal(sw.packages["node_modules/a"].resolved, "https://registry.npmjs.org/a/-/a-1.0.0.tgz");
    assert.equal(sw.packages["node_modules/b"].integrity, "sha512-b");
    assert.equal(sw.packages["node_modules/b"].hasInstallScript, true);
    const manifest = { name: "app", version: "0.1.0", dependencies: { a: "1.0.0" } };
    const problems = shrinkwrapProblems(manifest, sw, graph);
    assert.ok(problems.some((p) => p.includes("node_modules/b: has an install script")));
    assert.ok(problems.some((p) => p.includes("b@2.1.0 runs an install script (postinstall)")));

    delete sw.packages["node_modules/b"];
    assert.ok(shrinkwrapProblems(manifest, sw, graph).includes("b@2.1.0 is installed but not in npm-shrinkwrap.json"));
    assert.ok(shrinkwrapProblems({ ...manifest, dependencies: { a: "1.0.1" } }, sw, graph).includes("root dependencies differ from package.json"));
    assert.throws(() => buildShrinkwrap(graph, new Map()), /not in pnpm-lock.yaml/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("refuses a required dependency that is not installed", () => {
  const { base, app } = fakeInstall();
  try {
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: { a: "1.0.0", missing: "1.0.0" } }));
    assert.throws(() => collectGraph(app), /needs missing@1.0.0/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
