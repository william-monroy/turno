import assert from "node:assert/strict";
import { test } from "node:test";
import { absolutize } from "./readme-for-npm.mjs";

test("relative links become GitHub URLs, images go to raw", () => {
  const md = '[b](BENCHMARKS.md) ![d](docs/assets/demo.gif) <img src="docs/assets/logo-light.svg"> [x](https://a.b) [v](#vendor-terms)';
  const out = absolutize(md);
  assert.match(out, /\(https:\/\/github\.com\/william-monroy\/turno\/blob\/main\/BENCHMARKS\.md\)/);
  assert.match(out, /\(https:\/\/raw\.githubusercontent\.com\/william-monroy\/turno\/main\/docs\/assets\/demo\.gif\)/);
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/william-monroy\/turno\/main\/docs\/assets\/logo-light\.svg"/);
  assert.match(out, /\(https:\/\/a\.b\)/);
  assert.match(out, /\(#vendor-terms\)/);
});
