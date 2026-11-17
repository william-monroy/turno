// Tests for the copy-artifact skill's scripts (plugins/turno/skills/copy-artifact/scripts). They
// run the scripts as the skill does, as child processes, with a sandbox HOME and cache folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "turno", "skills", "copy-artifact", "scripts");
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const NEW_A = "1".repeat(32);
const NEW_B = "2".repeat(32);

let home;
let src;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turno-copy-artifact-"));
  src = join(home, "scratch", "artifact");
  mkdirSync(join(src, "project", "pages"), { recursive: true });
  mkdirSync(join(home, "downloads"));
  writeFileSync(join(src, "project", "canvas.json"), JSON.stringify({ font: `/_blob/${A}`, hero: `/_blob/${B}`, again: `/_blob/${A}` }));
  writeFileSync(join(src, "project", "pages", "one.html"), `<img src="/_blob/${B}">`);
  writeFileSync(join(src, "project", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(home, "downloads", `${A}.woff2`), "font bytes");
  writeFileSync(join(home, "downloads", `${B}.png`), "image bytes");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(script, args) {
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache") };
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const blob = (id, ext) => `--blob=${id}=${join(home, "downloads", `${id}${ext}`)}`;
const base = () => ["--from", src, "--url", "https://claude.ai/artifact/x", "--title", "Café Lienzo: Diseño", "--profile", "work", "--type", "Design"];
const allPaths = ["project/canvas.json", "project/pages/one.html", "project/logo.png"];
const packages = () => (existsSync(join(home, ".cache", "turno", "artifacts")) ? readdirSync(join(home, ".cache", "turno", "artifacts")) : []);
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function packOk() {
  const r = run("pack.mjs", [...base(), "--main", "project/canvas.json", blob(A, ".woff2"), blob(B, ".png"), ...allPaths]);
  assert.equal(r.code, 0, r.err);
  return r.out.trim();
}

test("pack bundles files, assets and a manifest in a private package and prints only its path", () => {
  const out = packOk();
  assert.match(out, /\/\.cache\/turno\/artifacts\/cafe-lienzo-diseno-\d{8}-\d{6}$/);
  assert.equal(out.split("\n").length, 1);
  for (const p of allPaths) assert.deepEqual(readFileSync(join(out, "files", p)), readFileSync(join(src, p)));
  assert.equal(readFileSync(join(out, "assets", `${A}.woff2`), "utf8"), "font bytes");
  assert.equal(readFileSync(join(out, "assets", `${B}.png`), "utf8"), "image bytes");
  const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(m.source, { url: "https://claude.ai/artifact/x", profile: "work", type: "Design" });
  assert.equal(m.title, "Café Lienzo: Diseño");
  assert.equal(m.main, "project/canvas.json");
  assert.deepEqual(
    m.files.map((f) => f.path),
    allPaths,
  );
  assert.equal(m.files[0].sha256, sha(join(src, "project", "canvas.json")));
  assert.equal(m.files[2].bytes, 4);
  assert.deepEqual(
    m.assets.map((a) => [a.id, a.file, a.references]),
    [
      [A, `${A}.woff2`, 2],
      [B, `${B}.png`, 2],
    ],
  );
  assert.match(m.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(statSync(join(out, "manifest.json")).mode & 0o777, 0o600);
});

test("pack writes a null type and takes the first path as main when they are not given", () => {
  writeFileSync(join(src, "index.html"), "<p>hi</p>");
  const r = run("pack.mjs", ["--from", src, "--url", "u", "--title", "!!!", "--profile", "personal", "index.html"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /1 files, 0 assets \(0 references\)/);
  const m = JSON.parse(readFileSync(join(r.out.trim(), "manifest.json"), "utf8"));
  assert.equal(m.source.type, null);
  assert.equal(m.main, "index.html");
  assert.match(r.out, /\/artifact-\d{8}-\d{6}\n$/);
});

const failures = [
  ["a missing file", () => [...base(), blob(A, ".woff2"), blob(B, ".png"), ...allPaths, "project/nope.css"], /project\/nope\.css is missing/],
  ["a path outside the folder", () => [...base(), "../outside.txt"], /outside/],
  ["an absolute path", () => [...base(), join(home, "downloads", `${A}.woff2`)], /outside/],
  ["a symlink that leaves the folder", () => {
      symlinkSync(join(home, "downloads", `${A}.woff2`), join(src, "link.woff2"));
      return [...base(), "link.woff2"];
    }, /outside/],
  ["an asset no file cites", () => [...base(), blob(A, ".woff2"), blob(B, ".png"), "project/pages/one.html"], new RegExp(`assets no file cites: ${A}`)],
  ["a cited asset with no --blob", () => [...base(), blob(A, ".woff2"), ...allPaths], new RegExp(`cite assets with no --blob: ${B}`)],
  ["a --blob that is not a 32 hex id", () => [...base(), `--blob=xyz=${join(home, "downloads", `${A}.woff2`)}`, ...allPaths], /invalid --blob/],
  ["a --blob whose file is missing", () => [...base(), `--blob=${A}=${join(home, "nope")}`, ...allPaths], /invalid --blob/],
  ["the same --blob twice", () => [...base(), blob(A, ".woff2"), blob(A, ".woff2"), blob(B, ".png"), ...allPaths], /given twice/],
  ["a main file that is not packed", () => [...base(), "--main", "index.html", blob(A, ".woff2"), blob(B, ".png"), ...allPaths], /main file index\.html/],
  ["a path named twice", () => [...base(), blob(A, ".woff2"), blob(B, ".png"), ...allPaths, "project/logo.png"], /named twice/],
  ["a missing source folder", () => ["--from", join(home, "nope"), "--url", "u", "--title", "t", "--profile", "p", "x"], /does not exist/],
];
for (const [name, argv, message] of failures) {
  test(`pack fails on ${name} and writes nothing`, () => {
    const r = run("pack.mjs", argv());
    assert.equal(r.code, 1, r.err);
    assert.equal(r.out, "");
    assert.match(r.err, /^error: /);
    assert.match(r.err, message);
    assert.deepEqual(packages(), []);
  });
}

test("pack fails with usage when a required flag or every path is missing", () => {
  for (const argv of [["--from", src, "--url", "u", "--title", "t", "x"], [...base()], [...base(), "--bogus", "x"]]) {
    const r = run("pack.mjs", argv);
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /usage: pack\.mjs/);
  }
});

function relinkSetup(map) {
  const out = packOk();
  const mapFile = join(home, "map.json");
  writeFileSync(mapFile, JSON.stringify(map));
  return { out, files: join(out, "files"), mapFile, manifest: join(out, "manifest.json") };
}

test("relink rewrites every old id and prints the count per asset", () => {
  const { files, mapFile, manifest } = relinkSetup({ [A]: `/_blob/${NEW_A}`, [B]: `/_blob/${NEW_B}` });
  const logo = readFileSync(join(files, "project", "logo.png"));
  const r = run("relink.mjs", [files, mapFile, "--manifest", manifest]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${A} -> /_blob/${NEW_A}: 2 replacements\n${B} -> /_blob/${NEW_B}: 2 replacements\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(files, "project", "canvas.json"), "utf8")), {
    font: `/_blob/${NEW_A}`,
    hero: `/_blob/${NEW_B}`,
    again: `/_blob/${NEW_A}`,
  });
  assert.equal(readFileSync(join(files, "project", "pages", "one.html"), "utf8"), `<img src="/_blob/${NEW_B}">`);
  assert.deepEqual(readFileSync(join(files, "project", "logo.png")), logo);
  // Run again: the new ids are known, nothing is left to replace.
  const again = run("relink.mjs", [files, mapFile]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /: 0 replacements\n/);
});

const relinkFailures = [
  ["an id the map does not know", { [A]: `/_blob/${NEW_A}` }, new RegExp(`not in the map: ${B}`)],
  ["a mapping that is not a /_blob/ url", { [A]: `https://claude.ai/_blob/${NEW_A}`, [B]: `/_blob/${NEW_B}` }, /invalid map entry/],
  ["an old key that is not a 32 hex id", { xyz: `/_blob/${NEW_A}`, [A]: `/_blob/${NEW_A}`, [B]: `/_blob/${NEW_B}` }, /invalid map entry/],
  ["a map that reuses an old id as a new one", { [A]: `/_blob/${B}`, [B]: `/_blob/${NEW_B}` }, /old id as a new one/],
];
for (const [name, map, message] of relinkFailures) {
  test(`relink fails on ${name} and changes nothing`, () => {
    const { files, mapFile } = relinkSetup(map);
    const before = readFileSync(join(files, "project", "canvas.json"), "utf8");
    const r = run("relink.mjs", [files, mapFile]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, message);
    assert.equal(readFileSync(join(files, "project", "canvas.json"), "utf8"), before);
  });
}

test("relink fails when the counts do not match the manifest, before writing", () => {
  const { files, mapFile, manifest } = relinkSetup({ [A]: `/_blob/${NEW_A}`, [B]: `/_blob/${NEW_B}`, [C]: `/_blob/${"3".repeat(32)}` });
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  m.assets[0].references = 3;
  writeFileSync(manifest, JSON.stringify(m));
  const before = readFileSync(join(files, "project", "canvas.json"), "utf8");
  const r = run("relink.mjs", [files, mapFile, "--manifest", manifest]);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, new RegExp(`${A}: 2 replacements, the manifest expects 3`));
  assert.match(r.err, new RegExp(`${C} is not an asset of the manifest`));
  assert.equal(readFileSync(join(files, "project", "canvas.json"), "utf8"), before);
});

test("relink fails with usage on missing arguments and on a bad map file", () => {
  assert.equal(run("relink.mjs", []).code, 2);
  const { files } = relinkSetup({});
  const bad = join(home, "bad.json");
  writeFileSync(bad, "[1]");
  assert.match(run("relink.mjs", [files, bad]).err, /must be a JSON object/);
  assert.match(run("relink.mjs", [files, join(home, "none.json")]).err, /cannot read the map/);
  assert.match(run("relink.mjs", [join(home, "none"), bad]).err, /does not exist/);
});
