import { completionScripts } from "turno-core/cli";
import { parseFlags } from "../args.js";
import { type Command, fail } from "../io.js";

export const SCRIPTS: Record<string, string> = completionScripts("turno");

export const command: Command = {
  summary: "shell completion for commands, profiles, identities and config keys",
  usage: [
    "Usage: turno completion <zsh|bash|fish>",
    "",
    "Prints the completion script. To load it in every shell:",
    "  zsh   echo 'source <(turno completion zsh)' >> ~/.zshrc",
    "  bash  echo 'eval \"$(turno completion bash)\"' >> ~/.bashrc",
    "  fish  turno completion fish > ~/.config/fish/completions/turno.fish",
    "",
    "Examples:",
    "  $ turno completion zsh",
    "  $ turno completion fish > ~/.config/fish/completions/turno.fish",
  ].join("\n"),
  args: ["shell"],
  async run(args, io) {
    const p = parseFlags(args, {}, 1);
    const script = SCRIPTS[p.positionals[0] ?? ""];
    if (!script) return fail("usage: turno completion <zsh|bash|fish>");
    io.out(script.trimEnd());
    return 0;
  },
};
