import { tildify } from "../../core/paths.js";
import { availableUpdate } from "../../core/update.js";
import { ONE_OFF_RUNNERS, detectInstall, isOneOff, packageInfo } from "../../core/version.js";
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
    // npx, pnpm dlx and bunx run a temporary copy from their cache: upgrade and launchers must not rely on it.
    const once = isOneOff(install.method) ? ONE_OFF_RUNNERS[install.method] : undefined;
    const data = { name: pkg.name, version: pkg.version, node: process.versions.node, method: install.method, path: tildify(install.root, io.env), latest: latest ?? null };
    if (bool(p, "json")) {
      emit(io, p, JSON_OUT, data);
      return 0;
    }
    io.out(`turno ${pkg.version}`);
    io.out(once ? `  a temporary copy in ${once.runner}'s cache (${data.path}); install it with: ${once.install}` : `  installed with ${install.method} at ${data.path}`);
    io.out(`  node ${data.node}`);
    if (latest) io.out(`  ${latest} is available: turno upgrade`);
    return 0;
  },
};
