import { type Command, fail } from "../io.js";

const ZSH = `#compdef claudio
# claudio completion for zsh. Load it with: source <(claudio completion zsh)
_claudio() {
  local -a out
  out=("\${(@f)$(claudio __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${out[1]}" == ":dir" ]]; then _files -/; return; fi
  (( \${#out} )) && [[ -n "\${out[1]}" ]] && compadd -- "\${out[@]}"
}
compdef _claudio claudio
`;

const BASH = `# claudio completion for bash. Load it with: source <(claudio completion bash)
_claudio() {
  local IFS=$'\\n'
  local out=($(claudio __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
  if [[ "\${out[0]}" == ":dir" ]]; then
    COMPREPLY=($(compgen -d -- "\${COMP_WORDS[COMP_CWORD]}"))
    return
  fi
  COMPREPLY=("\${out[@]}")
}
complete -o default -F _claudio claudio
`;

const FISH = `# claudio completion for fish. Load it with: claudio completion fish | source
function __claudio_complete
  set -l words (commandline -opc) (commandline -ct)
  set -e words[1]
  set -l out (claudio __complete -- $words 2>/dev/null)
  if test "$out[1]" = ":dir"
    __fish_complete_directories (commandline -ct)
    return
  end
  printf '%s\\n' $out
end
complete -c claudio -f -a '(__claudio_complete)'
`;

export const SCRIPTS: Record<string, string> = { zsh: ZSH, bash: BASH, fish: FISH };

export const command: Command = {
  summary: "shell completion for commands, profiles, identities and config keys",
  usage: [
    "Usage: claudio completion <zsh|bash|fish>",
    "",
    "Prints the completion script. To load it in every shell:",
    "  zsh   echo 'source <(claudio completion zsh)' >> ~/.zshrc",
    "  bash  echo 'source <(claudio completion bash)' >> ~/.bashrc",
    "  fish  claudio completion fish > ~/.config/fish/completions/claudio.fish",
  ].join("\n"),
  args: ["shell"],
  async run(args, io) {
    const script = SCRIPTS[args[0] ?? ""];
    if (!script || args.length > 1) return fail("usage: claudio completion <zsh|bash|fish>");
    io.out(script.trimEnd());
    return 0;
  },
};
