import type { Command } from "../io.js";
import { whichCommand } from "./profile.js";

/** The 0.1 `turno which`; `which` is now an alias of `turno profile which`, which this runs. */
export const command: Command = {
  summary: "which account auto would use in a folder, and why",
  usage: "Usage: turno profile which [dir] [--json]\n\nExplains the profile resolution for a folder (default: the current one), for each agent.",
  hidden: true,
  args: ["dir"],
  flags: ["--json"],
  run: whichCommand,
};
