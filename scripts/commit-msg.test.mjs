import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMessage } from "./commit-msg.mjs";

test("accepts a conventional subject with scope, bang and body", () => {
  assert.deepEqual(checkMessage("feat(mcpd): start servers lazily\n\nLonger body.\n"), []);
  assert.deepEqual(checkMessage("refactor!: rename the project"), []);
  assert.deepEqual(checkMessage("fix: handle a missing token\n\nSigned-off-by: Alice <alice@example.com>\n"), []);
});

test("rejects a subject without a known type", () => {
  assert.equal(checkMessage("update stuff").length, 1);
  assert.equal(checkMessage("feature: add x").length, 1);
  assert.equal(checkMessage("feat(cli) missing colon").length, 1);
});

test("rejects attribution trailers for tools", () => {
  for (const trailer of [
    "Co-Authored-By: Some Bot <noreply@example.com>",
    "co-authored-by: Some Bot <noreply@example.com>",
    "Assisted-by: an assistant",
    "Generated with some tool",
    "Claude-Session: abc",
  ]) {
    assert.ok(checkMessage(`feat: x\n\n${trailer}\n`).length > 0, trailer);
  }
});

test("rejects the em dash", () => {
  assert.ok(checkMessage(`docs: a ${String.fromCharCode(0x2014)} b`).length > 0);
});

test("ignores comment lines git adds to the editor", () => {
  assert.deepEqual(
    checkMessage("chore: tidy\n# Please enter the commit message\n# Co-Authored-By: shown in a comment\n"),
    [],
  );
});

test("lets merge and revert messages through", () => {
  assert.deepEqual(checkMessage("Merge branch 'main' into feature"), []);
  assert.deepEqual(checkMessage('Revert "feat: x"'), []);
});
