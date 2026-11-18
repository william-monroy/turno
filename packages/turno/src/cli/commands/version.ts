import { tildify } from "../../core/paths.js";
import { availableUpdate } from "../../core/update.js";
import { detectInstall, packageInfo } from "../../core/version.js";
import { JSON_FLAG, bool, flagsOf, parseFlags } from "../args.js";
import type { Command } from "../io.js";
import { emit, jsonOutput } from "../output.js";

const JSON_OUT = jsonOutput(["name", "version", "node", "method", "path", "latest"]);

export const command: Command = {
  summary: "the turno version, how it was installed, and whether a newer one is known",
  usage: "Usage: turno version [--json]\n\nturno --version prints only the number.\n\nExamples:\n  $ turno version\n  $ turno version --json",
  flags: flagsOf(JSON_FLAG),
  json: JSON_OUT,
  async run(args, io) {
    const p = parseFlags(args, JSON_FLAG, 0);
    const pkg = packageInfo();
    const install = detectInstall();
    const latest = availableUpdate(io.env);
    // npx runs a temporary copy from its cache: upgrade and launchers must not rely on it.
    const npx = install.root.includes("/_npx/");
    const data = { name: pkg.name, version: pkg.version, node: process.versions.node, method: npx ? "npx" : install.method, path: tildify(install.root, io.env), latest: latest ?? null };
    if (bool(p, "json")) {
      emit(io, p, JSON_OUT, data);
      return 0;
    }
    io.out(`turno ${pkg.version}`);
    io.out(npx ? `  a temporary copy in npx's cache (${data.path}); install it with: npm install --global turno-cli` : `  installed with ${install.method} at ${data.path}`);
    io.out(`  node ${data.node}`);
    if (latest) io.out(`  ${latest} is available: turno upgrade`);
    return 0;
  },
};
