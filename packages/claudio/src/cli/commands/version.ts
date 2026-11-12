import { tildify } from "../../core/paths.js";
import { availableUpdate } from "../../core/update.js";
import { detectInstall, packageInfo } from "../../core/version.js";
import { JSON_FLAG, bool, parseFlags, printJson } from "../args.js";
import type { Command } from "../io.js";

export const command: Command = {
  summary: "the claudio version, how it was installed, and whether a newer one is known",
  usage: "Usage: claudio version [--json]\n\nclaudio --version prints only the number.",
  flags: ["--json"],
  async run(args, io) {
    const p = parseFlags(args, JSON_FLAG, 0);
    const pkg = packageInfo();
    const install = detectInstall();
    const latest = availableUpdate(io.env);
    const data = { name: pkg.name, version: pkg.version, node: process.versions.node, method: install.method, path: tildify(install.root, io.env), latest: latest ?? null };
    if (bool(p, "json")) {
      printJson(io.out, data);
      return 0;
    }
    io.out(`claudio ${pkg.version}`);
    io.out(`  installed with ${install.method} at ${data.path}`);
    io.out(`  node ${data.node}`);
    if (latest) io.out(`  ${latest} is available: claudio upgrade`);
    return 0;
  },
};
