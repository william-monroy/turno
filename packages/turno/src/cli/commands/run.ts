import type { Command } from "../io.js";
import { launchProfile } from "../launch.js";
import { command as auto } from "./auto.js";

export const command: Command = {
  summary: "open a profile with its agent (turno <profile> is the short form), or auto",
  usage: [
    "Usage: turno run <profile|auto> [--no-gateway] [agent args]",
    "",
    "Everything after the profile goes to its agent, for example:",
    "  turno run work --resume",
    "",
    "Without a profile, a terminal shows the profiles to choose from. When this",
    "folder resolves to a profile, auto comes first, named with it: auto (work).",
    "",
    "Safe mode: --no-gateway (or TURNO_SAFE=1) opens the profile with its account",
    "but without turno's gateway: no mcpd entries, no gateway token, and for Claude",
    "Code no status line (and no hooks). If a problem goes away in safe mode, it",
    "comes from turno. Claude Code gets --strict-mcp-config with the profile's other",
    "servers, Codex -c mcp_servers.<name>.enabled=false and Copilot",
    "--disable-mcp-server for each gateway entry; Cursor has no switch for one run,",
    "so its entries start without the token and mcpd refuses them.",
    "",
    "Examples:",
    "  $ turno run work",
    "  $ turno run work --resume  # arguments go to the agent",
    "  $ turno run auto",
    "  $ turno run work --no-gateway  # safe mode",
    "  $ TURNO_SAFE=1 turno work",
  ].join("\n"),
  args: ["profile-or-auto"],
  flags: ["--no-gateway"],
  async run(given, io) {
    // `turno run --no-gateway work` as well as `turno run work --no-gateway`.
    const lead = given[0] === "--no-gateway";
    let [name, ...rest] = lead ? given.slice(1) : given;
    if (lead) rest = ["--no-gateway", ...rest];
    if (!name) {
      const { pickProfile } = await import("../picker.js");
      name = await pickProfile(io, { command: "run", title: "Profile to open", extra: ["auto"], auto: true });
      rest = lead ? ["--no-gateway"] : [];
    }
    return name === "auto" ? auto.run(rest, io) : launchProfile(name, rest, io);
  },
};
