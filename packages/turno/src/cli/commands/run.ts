import { fail, type Command } from "../io.js";
import { launchProfile } from "../launch.js";
import { command as auto } from "./auto.js";

export const command: Command = {
  summary: "open a profile with its agent (turno <profile> is the short form), or auto",
  usage: [
    "Usage: turno run <profile|auto> [agent args]",
    "",
    "Everything after the profile goes to its agent, for example:",
    "  turno run work --resume",
  ].join("\n"),
  args: ["profile-or-auto"],
  async run(args, io) {
    const [name, ...rest] = args;
    if (!name) return fail("usage: turno run <profile|auto> [agent args]");
    return name === "auto" ? auto.run(rest, io) : launchProfile(name, rest, io);
  },
};
