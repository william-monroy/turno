import { parseFlags } from "../args.js";
import { type Command, fail } from "../io.js";

const ZSH = `#compdef turno
# turno completion for zsh. Load it with: source <(turno completion zsh)
_turno() {
  local -a out
  out=("\${(@f)$(turno __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${out[1]}" == ":dir" ]]; then _files -/; return; fi
  (( \${#out} )) && [[ -n "\${out[1]}" ]] && compadd -- "\${out[@]}"
}
compdef _turno turno
`;

const BASH = `# turno completion for bash. Load it with: source <(turno completion bash)
_turno() {
  local IFS=$'\\n'
  local out=($(turno __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
  if [[ "\${out[0]}" == ":dir" ]]; then
    COMPREPLY=($(compgen -d -- "\${COMP_WORDS[COMP_CWORD]}"))
    return
  fi
  COMPREPLY=("\${out[@]}")
}
complete -o default -F _turno turno
`;

const FISH = `# turno completion for fish. Load it with: turno completion fish | source
function __turno_complete
  set -l words (commandline -opc) (commandline -ct)
  set -e words[1]
  set -l out (turno __complete -- $words 2>/dev/null)
  if test "$out[1]" = ":dir"
    __fish_complete_directories (commandline -ct)
    return
  end
  printf '%s\\n' $out
end
complete -c turno -f -a '(__turno_complete)'
`;

export const SCRIPTS: Record<string, string> = { zsh: ZSH, bash: BASH, fish: FISH };

export const command: Command = {
  summary: "shell completion for commands, profiles, identities and config keys",
  usage: [
    "Usage: turno completion <zsh|bash|fish>",
    "",
    "Prints the completion script. To load it in every shell:",
    "  zsh   echo 'source <(turno completion zsh)' >> ~/.zshrc",
    "  bash  echo 'source <(turno completion bash)' >> ~/.bashrc",
    "  fish  turno completion fish > ~/.config/fish/completions/turno.fish",
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
