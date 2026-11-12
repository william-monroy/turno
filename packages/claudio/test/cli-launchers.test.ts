import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/cli/io.js";
import { MARKER, launcherText, shPath, writeHelperLaunchers, writeLauncher } from "../src/cli/launchers.js";
import { fakeCommand } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("launchers", () => {
  it("writes the launcher contract", () => {
    const text = launcherText("work", sb.env);
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(MARKER);
    expect(text).toContain('export CLAUDE_CONFIG_DIR="$HOME/.claude-work"');
    expect(text).toContain('export CLAUDIO_PROFILE="work"');
    expect(text).toContain("export CLAUDIO_SESSION_PID=$$");
    expect(text).toContain('export BROWSER="$HOME/.local/bin/claudio-open"');
    expect(text).toContain('"$HOME/.claude/projects"');
    expect(text).toContain('"$HOME/.claude/sessions"');
    expect(text).toContain('mkdir -p "$HOME/.local/state/claudio/run" && echo work >"$HOME/.local/state/claudio/run/$$"');
    expect(text.trimEnd().endsWith('exec claude "$@"')).toBe(true);
  });

  it("quotes paths outside HOME", () => {
    expect(shPath("/opt/my $dir", sb.env)).toBe('"/opt/my \\$dir"');
    expect(shPath(join(sb.home, "a b"), sb.env)).toBe('"$HOME/a b"');
  });

  it("runs claude with the profile env and writes the run record", () => {
    fakeCommand(sb, "claude", 'echo "$CLAUDE_CONFIG_DIR|$CLAUDIO_PROFILE|$CLAUDIO_SESSION_PID|$BROWSER|$*"');
    const file = writeLauncher("work", sb.env);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    const out = execFileSync(file, ["--resume", "x"], { env: sb.env, encoding: "utf8" }).trim();
    const [configDir, profile, pid, browser, args] = out.split("|");
    expect(configDir).toBe(join(sb.home, ".claude-work"));
    expect(profile).toBe("work");
    expect(browser).toBe(join(sb.home, ".local/bin/claudio-open"));
    expect(args).toBe("--resume x");
    const record = join(sb.home, ".local/state/claudio/run", pid!);
    expect(readFileSync(record, "utf8").trim()).toBe("work");
    expect(existsSync(join(sb.home, ".claude/plugins"))).toBe(true);
  });

  it("overwrites only files claudio generated", () => {
    const file = sb.write(".local/bin/claude-work", "#!/bin/sh\n# my own script\n");
    expect(() => writeLauncher("work", sb.env)).toThrow(UsageError);
    expect(readFileSync(file, "utf8")).toContain("my own script");
    for (const marker of ["Generado por claudio", "Generado por claude-profile", MARKER]) {
      writeFileSync(file, `#!/bin/sh\n# ${marker}: old\n`);
      writeLauncher("work", sb.env);
      expect(readFileSync(file, "utf8")).toBe(launcherText("work", sb.env));
    }
  });

  it("writes claudio-auto and claudio-open and rewrites an old claudio-navegador", () => {
    sb.write(".local/bin/claudio-navegador", '#!/bin/sh\n# Generado por claudio: x\nexec claudio abrir "$@"\n');
    const written = writeHelperLaunchers(sb.env, '"/opt/claudio/main.js"');
    expect(written).toEqual(["claudio-auto", "claudio-open", "claudio-navegador"]);
    const bin = join(sb.home, ".local/bin");
    expect(readFileSync(join(bin, "claudio-auto"), "utf8")).toContain('exec "/opt/claudio/main.js" auto "$@"');
    expect(readFileSync(join(bin, "claudio-open"), "utf8")).toContain('exec "/opt/claudio/main.js" open "$@"');
    expect(readFileSync(join(bin, "claudio-navegador"), "utf8")).toBe(readFileSync(join(bin, "claudio-open"), "utf8"));
  });

  it("leaves a foreign claudio-navegador alone and does not create one", () => {
    const own = sb.write(".local/bin/claudio-navegador", "#!/bin/sh\necho mine\n");
    expect(writeHelperLaunchers(sb.env, "claudio")).toEqual(["claudio-auto", "claudio-open"]);
    expect(readFileSync(own, "utf8")).toContain("mine");
    sb.cleanup();
    sb = sandbox();
    writeHelperLaunchers(sb.env, "claudio");
    expect(existsSync(join(sb.home, ".local/bin/claudio-navegador"))).toBe(false);
  });
});
