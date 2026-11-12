import { loadConfig } from "../../core/config.js";
import { fetchLatest, updateChecksOff } from "../../core/update.js";
import type { Command } from "../io.js";

/** Background registry check started by the update notice. Prints nothing. */
export const command: Command = {
  summary: "background update check",
  usage: "Usage: turno __update-check",
  hidden: true,
  async run(_args, io) {
    let configured = true;
    try {
      configured = loadConfig(io.env).updateCheck;
    } catch {
      /* default */
    }
    if (updateChecksOff(io.env, configured)) return 0;
    await fetchLatest(io.env);
    return 0;
  },
};
