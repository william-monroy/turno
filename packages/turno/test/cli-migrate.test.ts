import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/cli/commands/migrate.js";
import { loadConfig } from "../src/core/config.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
const PROYECTOS = [
  "# profile per project",
  "sistema personal",
  "por-defecto personal",
  "respaldo work",
  "iconos nerd",
  "work ~/code/acme   # client work",
  "work /opt/shared code",
  "personal ~/notes",
  "",
].join("\n");

beforeEach(() => {
  sb = sandbox();
  sb.write(".config/claudio/proyectos", PROYECTOS);
  sb.write(".config/claudio/navegador", "work chrome\npersonal predeterminado\n");
  sb.write(".config/claudio/uso/work.json", '{"updated_at": 1}\n');
  sb.write(".config/claudio/agotadas/work", "1999999999\n");
  sb.write(".config/claudio/plan/work", "max\n");
  mkdirSync(join(sb.home, ".config/claudio/chrome/work"), { recursive: true });
});
afterEach(() => sb.cleanup());

describe("migrate", () => {
  it("writes config.toml and copies state, leaving legacy files alone", () => {
    const io = fakeIo(sb.env);
    expect(migrate(io)).toBe(0);
    const c = loadConfig(sb.env);
    expect(c.system).toBe("personal");
    expect(c.default).toBe("personal");
    expect(c.fallback).toBe("work");
    expect(c.icons).toBe("nerd");
    expect(c.profiles).toEqual({ personal: { browser: "default" }, work: { browser: "chrome" } });
    expect(c.projects).toEqual([
      { path: join(sb.home, "code/acme"), profile: "work" },
      { path: "/opt/shared code", profile: "work" },
      { path: join(sb.home, "notes"), profile: "personal" },
    ]);
    expect(c.open.chromeDir).toBe(join(sb.home, ".config/claudio/chrome"));
    const state = join(sb.home, ".local/state/turno");
    expect(readFileSync(join(state, "usage/work.json"), "utf8")).toContain("updated_at");
    expect(readFileSync(join(state, "exhausted/work"), "utf8").trim()).toBe("1999999999");
    expect(readFileSync(join(state, "plan/work"), "utf8").trim()).toBe("max");
    expect(readFileSync(join(sb.home, ".config/claudio/proyectos"), "utf8")).toBe(PROYECTOS);
    expect(io.lines.some((l) => l.includes("3 project rules, 2 browser settings"))).toBe(true);
  });

  it("refuses to replace config.toml without --force, and backs it up with it", async () => {
    sb.write(".config/turno/config.toml", 'system = "old"\n');
    expect(() => migrate(fakeIo(sb.env))).toThrow(/--force/);
    migrate(fakeIo(sb.env), { force: true });
    expect(loadConfig(sb.env).system).toBe("personal");
    const backups = join(sb.home, ".local/state/turno/backups");
    const [stamp] = readdirSync(backups);
    expect(readFileSync(join(backups, stamp!, "files", "0-config.toml"), "utf8")).toBe('system = "old"\n');
    // turno undo is the rollback of a migration.
    const { listJournals, undoJournal } = await import("../src/core/journal.js");
    undoJournal(listJournals(sb.env)[0]!, sb.env);
    expect(readFileSync(join(sb.home, ".config/turno/config.toml"), "utf8")).toBe('system = "old"\n');
  });

  it("changes nothing on a dry run", () => {
    const io = fakeIo(sb.env);
    migrate(io, { dryRun: true });
    expect(existsSync(join(sb.home, ".config/turno/config.toml"))).toBe(false);
    expect(existsSync(join(sb.home, ".local/state/turno"))).toBe(false);
    expect(io.lines).toContain("[[projects]]");
  });

  it("does nothing without legacy files", () => {
    sb.cleanup();
    sb = sandbox();
    const io = fakeIo(sb.env);
    expect(migrate(io)).toBe(0);
    expect(io.lines[0]).toMatch(/^Nothing to migrate/);
  });
});
