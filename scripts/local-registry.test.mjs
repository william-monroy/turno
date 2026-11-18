import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packument, serve } from "./local-registry.mjs";

/** A folder with one packed package, as `npm pack` lays it out. */
function folderWith(manifest) {
  const root = mkdtempSync(join(tmpdir(), "turno-local-registry-"));
  mkdirSync(join(root, "src", "package"), { recursive: true });
  writeFileSync(join(root, "src", "package", "package.json"), JSON.stringify(manifest));
  mkdirSync(join(root, "out"));
  const file = join(root, "out", `${manifest.name}-${manifest.version}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", join(root, "src"), "package"]);
  return { root, folder: join(root, "out"), file };
}

test("packument lists the tarball as the only, latest version, with its integrity and an old date", () => {
  const bytes = Buffer.from("tarball bytes");
  const doc = packument({ manifest: { name: "turno-core", version: "0.0.0" }, bytes }, "http://127.0.0.1:1/");
  assert.deepEqual(doc["dist-tags"], { latest: "0.0.0" });
  const v = doc.versions["0.0.0"];
  assert.equal(v.dist.tarball, "http://127.0.0.1:1/turno-core/-/turno-core-0.0.0.tgz");
  assert.equal(v.dist.integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
  assert.ok(Date.parse(doc.time["0.0.0"]) < Date.now() - 365 * 24 * 3600 * 1000);
});

test("serves the packument and the tarball of each packed package", async () => {
  const { root, folder, file } = folderWith({ name: "turno-core", version: "0.0.0", type: "module" });
  const { url, server } = await serve(folder);
  try {
    const doc = await (await fetch(`${url}turno-core`)).json();
    assert.equal(doc.versions["0.0.0"].type, "module");
    const res = await fetch(doc.versions["0.0.0"].dist.tarball);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(file));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
