import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpgrade } from "../src/cli/commands/upgrade.js";
import { NPX_MESSAGE, refuseNpx, runningFromNpx } from "../src/cli/launchers.js";
import { loadOptional, pnpmGlobalRoots } from "../src/cli/optional.js";
import { detectInstall, oneOffRunner, upgradeCommand } from "../src/core/version.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * How turno tells the package managers apart (core/version.ts), from the folders each one
 * really uses (measured with npm 12, pnpm 12, bun 1.3 and yarn 1.22), including the custom
 * prefixes CI and some users set: npm --prefix, PNPM_HOME, BUN_INSTALL, yarn --global-folder.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A package folder at `rel` under the sandbox, with `marker` files in the install's top folder. */
function installAt(rel: string, top?: string, markers: string[] = []): string {
  const root = join(sb.home, rel);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  for (const m of markers) writeFileSync(join(sb.home, top!, m), "");
  return root;
}

describe("detectInstall", () => {
  it("finds yarn, bun and pnpm from their lockfile even under a custom folder", () => {
    expect(
      detectInstall(installAt("ci/yarn-global/node_modules/turno-cli", "ci/yarn-global", ["yarn.lock"])).method,
    ).toBe("yarn");
    expect(
      detectInstall(installAt("ci/bun/install/global/node_modules/turno-cli", "ci/bun/install/global", ["bun.lock"]))
        .method,
    ).toBe("bun");
    expect(
      detectInstall(installAt("ci/bun0/install/global/node_modules/turno-cli", "ci/bun0/install/global", ["bun.lockb"]))
        .method,
    ).toBe("bun");
    const group = "ci/pnpm-home/global/v11/af12-18e915da3d9ecb20-0";
    expect(
      detectInstall(
        installAt(`${group}/node_modules/.pnpm/turno-cli@0.2.0/node_modules/turno-cli`, group, ["pnpm-lock.yaml"]),
      ).method,
    ).toBe("pnpm");
    expect(detectInstall(installAt("ci/npm-prefix/lib/node_modules/turno-cli")).method).toBe("npm");
  });

  it("keeps the path rules for the default folders", () => {
    expect(detectInstall("/Users/a/.config/yarn/global/node_modules/turno-cli").method).toBe("yarn");
    expect(detectInstall("/Users/a/.bun/install/global/node_modules/turno-cli").method).toBe("bun");
    expect(
      detectInstall("/home/a/.local/share/pnpm/global/v11/x/node_modules/.pnpm/turno-cli@1/node_modules/turno-cli")
        .method,
    ).toBe("pnpm");
    expect(detectInstall("/Users/a/.volta/tools/image/packages/turno-cli/lib/node_modules/turno-cli").method).toBe(
      "volta",
    );
  });

  it("tells a one-off run (npx, pnpm dlx, bunx) from an install", () => {
    const npx = "/Users/a/.npm/_npx/f900a4dee79e05d6/node_modules/turno-cli";
    const dlx =
      "/home/a/.cache/pnpm/dlx/8bc2941/mwlup6zi-zae/node_modules/.pacquet/turno-cli@0.2.0/node_modules/turno-cli";
    const dlxMac =
      "/Users/a/Library/Caches/pnpm/dlx/8bc2941/19a-1/node_modules/.pnpm/turno-cli@0.2.0/node_modules/turno-cli";
    const bunx = "/private/var/folders/x/T/bunx-501-turno-cli@latest/node_modules/turno-cli";
    expect([npx, dlx, dlxMac, bunx].map((p) => detectInstall(p).method)).toEqual([
      "npx",
      "pnpm-dlx",
      "pnpm-dlx",
      "bunx",
    ]);
    expect([npx, dlx, bunx].map((p) => oneOffRunner(p))).toEqual(["npx", "pnpm dlx", "bunx"]);
    expect(oneOffRunner("/Users/a/.bun/install/global/node_modules/turno-cli")).toBeUndefined();
    // A one-off copy has nothing to upgrade: the next run fetches the newest release.
    for (const p of [npx, dlx, bunx]) expect(upgradeCommand(detectInstall(p), "turno-cli", "1.0.0")).toBeUndefined();
  });

  it("upgrades each install with its own package manager", () => {
    const cmd = (method: string) => upgradeCommand({ method: method as never, root: "/x" }, "turno-cli", "1.2.3");
    expect(cmd("npm")).toEqual([["npm", "install", "--global", "turno-cli@1.2.3"]]);
    expect(cmd("pnpm")).toEqual([["pnpm", "add", "--global", "turno-cli@1.2.3"]]);
    expect(cmd("bun")).toEqual([["bun", "add", "--global", "turno-cli@1.2.3"]]);
    expect(cmd("yarn")).toEqual([["yarn", "global", "add", "turno-cli@1.2.3"]]);
  });
});

describe("one-off runs", () => {
  it("refuses writes that keep a path into a one-off runner's cache", () => {
    for (const rel of [
      ".npm/_npx/abc/node_modules/turno-cli/dist/cli/main.js",
      ".cache/pnpm/dlx/abc/1/node_modules/.pnpm/turno-cli@1/node_modules/turno-cli/dist/cli/main.js",
      "tmp/bunx-501-turno-cli@latest/node_modules/turno-cli/dist/cli/main.js",
    ]) {
      const file = sb.write(rel, "");
      expect(runningFromNpx(file), rel).toBe(true);
      expect(() => refuseNpx(file)).toThrow(NPX_MESSAGE);
    }
    expect(NPX_MESSAGE).toMatch(/npx, pnpm dlx or bunx/);
  });

  it("says how to get the newest release instead of upgrading a one-off copy", async () => {
    const io = fakeIo(sb.env);
    expect(
      await runUpgrade(["--dry-run"], io, {
        install: { method: "pnpm-dlx", root: "/c/pnpm/dlx/x/node_modules/turno-cli" },
      }),
    ).toBe(0);
    expect(io.lines.join("\n")).toMatch(
      /^turno runs from pnpm dlx's cache for this run: `pnpm dlx turno-cli@latest` runs the newest release\.\nTo keep turno, install it: pnpm add --global turno-cli$/,
    );
  });
});

describe("turno-browser next to a pnpm install", () => {
  it("finds a package pnpm installed globally in its own group", async () => {
    const v11 = join(sb.home, "pnpm-home/global/v11");
    const self = join(v11, "aaa-0/node_modules/.pnpm/turno-cli@0.2.0/node_modules/turno-cli");
    mkdirSync(self, { recursive: true });
    const other = join(v11, "bbb-1/node_modules/turno-example");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "package.json"),
      JSON.stringify({ name: "turno-example", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(other, "index.js"), "export const hello = () => 'from pnpm';\n");
    mkdirSync(join(v11, "ccc-2/node_modules"), { recursive: true });
    expect(pnpmGlobalRoots(self)).toEqual([
      join(v11, "aaa-0/node_modules"),
      join(v11, "bbb-1/node_modules"),
      join(v11, "ccc-2/node_modules"),
    ]);
    expect(pnpmGlobalRoots("/usr/lib/node_modules/turno-cli")).toEqual([]);
    const seen: string[] = [];
    const mod = await loadOptional<{ hello(): string }>(
      { name: "turno-example", install: "npm install --global turno-example" },
      {
        global: true,
        self,
        globalRoot: () => undefined,
        importer: async (s) => {
          seen.push(s);
          if (!s.startsWith("file:")) throw Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
          return import(s);
        },
      },
    );
    expect(mod?.hello()).toBe("from pnpm");
    expect(seen.at(-1)).toBe(pathToFileURL(join(other, "index.js")).href);
  });
});
