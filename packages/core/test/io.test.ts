import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quietOnClosedPipe } from "../src/cli/io.js";

const stream = () => new EventEmitter() as unknown as NodeJS.WriteStream;
const pipeError = (code: string) => Object.assign(new Error(`write ${code}`), { code });

afterEach(() => vi.restoreAllMocks());

describe("a closed pipe on stdout", () => {
  it("exits quietly with 0 when the reader is gone (turno --help | head)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const out = stream();
    quietOnClosedPipe(out);
    out.emit("error", pipeError("EPIPE"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("leaves any other stream error to Node", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const out = stream();
    quietOnClosedPipe(out);
    expect(() => out.emit("error", pipeError("EIO"))).toThrow("write EIO");
    expect(exit).not.toHaveBeenCalled();
  });
});
