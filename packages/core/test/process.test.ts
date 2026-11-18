import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parentIsInit, parseProcTable, pidAlive, readProcTable, signalProcess } from "../src/process.js";

describe("process helpers", () => {
  it("parses ps output with process groups and skips other lines", () => {
    const t = parseProcTable(
      "  1     0     1 /sbin/launchd\n 42     1    42 /Applications/Chrome --user-data-dir=/a b\ngarbage\n",
    );
    expect([...t.keys()]).toEqual([1, 42]);
    expect(t.get(42)).toEqual({ pid: 42, ppid: 1, pgid: 42, command: "/Applications/Chrome --user-data-dir=/a b" });
    expect(parentIsInit(1, t)).toBe(true);
    expect(parentIsInit(42, t)).toBe(false);
    expect(parentIsInit(999, t)).toBe(true);
  });

  it("reads this process from the real process table", () => {
    const t = readProcTable();
    if (!t) return; // no ps here
    expect(t.get(process.pid)?.ppid).toBe(process.ppid);
  });

  it("tells a live process from a gone one, and signals without throwing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(pidAlive(pid)).toBe(true);
    const exited = new Promise((r) => child.once("exit", r));
    signalProcess(pid, "SIGTERM");
    await exited;
    expect(pidAlive(pid)).toBe(false);
    expect(() => signalProcess(pid, "SIGTERM")).not.toThrow();
  });
});
