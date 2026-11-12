import { isValidProfileName } from "../../core/config.js";
import { clearExhausted } from "../../core/exhausted.js";
import { type Command, fail } from "../io.js";

export const command: Command = {
  summary: "clear a profile's exhausted mark",
  usage: "Usage: claudio available <profile>",
  async run(args, io) {
    const name = args[0];
    if (!name) fail("usage: claudio available <profile>");
    if (!isValidProfileName(name)) fail(`invalid profile name: '${name}'`);
    clearExhausted(name, io.env);
    io.out(`${name} available again`);
    return 0;
  },
};
