import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway HOME with the env turno reads. Never touches the real home. */
export interface Sandbox {
  home: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string, mode?: number): string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "turno-test-")));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    // On a CI runner a real Chrome can take more than upstream's 5 s for one action (a fill right
    // after a navigation, a click that opens a popup). Servers started with this env get 15 s;
    // a test that sets --timeout-action keeps its own value, since the flag wins over the env.
    ...(process.env.CI ? { PLAYWRIGHT_MCP_TIMEOUT_ACTION: "15000" } : {}),
  };
  return {
    home,
    env,
    write(rel, content, mode) {
      const file = join(home, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, mode !== undefined ? { mode } : undefined);
      return file;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
