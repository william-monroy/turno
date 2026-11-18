import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogSection, publishOrder, releaseNotes, releaseSlug } from "./release-plan.mjs";

const pkg = (dir, name, dependencies = {}, extra = {}) => ({
  dir,
  manifest: { name, version: "1.0.0", dependencies, ...extra },
});

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
  assert.throws(
    () => publishOrder([pkg("a", "a", { b: "workspace:*" }), pkg("b", "b", { a: "workspace:*" })]),
    /cycle: a -> b -> a/,
  );
});

const CHANGELOG = `# turno-cli

## 0.3.0

### Minor Changes

- abc1234: New thing.

## 0.2.0

### Minor Changes

- def5678: Old thing.
`;

test("a release page slug has no dots", () => {
  assert.equal(releaseSlug("0.3.0"), "v0-3-0");
  assert.equal(releaseSlug("1.2.0-next.0"), "v1-2-0-next-0");
});

test("takes one version's section of a CHANGELOG", () => {
  assert.equal(changelogSection(CHANGELOG, "0.3.0"), "### Minor Changes\n\n- abc1234: New thing.");
  assert.equal(changelogSection(CHANGELOG, "0.2.0"), "### Minor Changes\n\n- def5678: Old thing.");
  assert.equal(changelogSection(CHANGELOG, "9.9.9"), "");
});

test("release notes link the release page, or the list when the version has none", () => {
  const withPage = releaseNotes({ changelog: CHANGELOG, version: "0.3.0", turnoVersion: "0.3.0", hasPage: true });
  assert.match(withPage, /^What's new in turno 0\.3\.0: https:\/\/turno\.wimo\.dev\/docs\/releases\/v0-3-0\n/);
  assert.match(withPage, /- abc1234: New thing\./);
  assert.doesNotMatch(withPage, /Old thing/);
  const without = releaseNotes({ changelog: "", version: "0.1.2", turnoVersion: "0.3.1", hasPage: false });
  assert.match(without, /^Every release of turno: https:\/\/turno\.wimo\.dev\/docs\/releases\n\nSee CHANGELOG\.md\./);
});
