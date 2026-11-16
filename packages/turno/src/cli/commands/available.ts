import { isValidProfileName } from "../../core/config.js";
import { clearExhausted } from "../../core/exhausted.js";
import { parseFlags } from "../args.js";
import { type Command, fail } from "../io.js";

export const command: Command = {
  summary: "clear a profile's exhausted mark",
  usage: "Usage: turno available <profile>",
  async run(args, io) {
    const name = parseFlags(args, {}, 1).positionals[0];
    if (!name) fail("usage: turno limit clear <profile>");
    if (!isValidProfileName(name)) fail(`invalid profile name: '${name}'`);
    clearExhausted(name, io.env);
    io.out(`${name} available again`);
    return 0;
  },
};
