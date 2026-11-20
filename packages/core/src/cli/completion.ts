/**
 * The shell completion scripts of a program built on this toolkit (`turno`, `turno-browser`).
 * Each one asks the program itself for candidates: `<program> __complete -- <words...>` prints
 * one per line, or a single `:dir` or `:file` to fall back to the shell's own path completion.
 */
export type Shell = "zsh" | "bash" | "fish";

export const SHELLS: readonly Shell[] = ["zsh", "bash", "fish"];

export function completionScripts(program: string): Record<Shell, string> {
  // A shell function name: `turno-browser` becomes `_turno_browser`.
  const fn = `_${program.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return {
    zsh: `#compdef ${program}
# ${program} completion for zsh. Load it with: source <(${program} completion zsh)
${fn}() {
  local -a out
  out=("\${(@f)$(${program} __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if [[ "\${out[1]}" == ":dir" ]]; then _files -/; return; fi
  if [[ "\${out[1]}" == ":file" ]]; then _files; return; fi
  (( \${#out} )) && [[ -n "\${out[1]}" ]] && compadd -- "\${out[@]}"
}
compdef ${fn} ${program}
`,
    // Written for the bash 3.2 macOS ships: the words are sliced before IFS changes (3.2 joins a
    // slice into one word under a custom IFS), arrays are declared apart from their assignment
    // (3.2 empties `local a=(...)`), and it loads with eval (3.2 cannot source a <(...)).
    bash: `# ${program} completion for bash. Load it with: eval "$(${program} completion bash)"
${fn}() {
  local -a words out
  words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local IFS=$'\\n'
  out=($(${program} __complete -- "\${words[@]}" 2>/dev/null))
  if [[ "\${out[0]}" == ":dir" ]]; then
    COMPREPLY=($(compgen -d -- "\${COMP_WORDS[COMP_CWORD]}"))
    return
  fi
  if [[ "\${out[0]}" == ":file" ]]; then
    COMPREPLY=($(compgen -f -- "\${COMP_WORDS[COMP_CWORD]}"))
    return
  fi
  COMPREPLY=("\${out[@]}")
}
complete -o default -F ${fn} ${program}
`,
    fish: `# ${program} completion for fish. Load it with: ${program} completion fish | source
function _${fn}_complete
  set -l words (commandline -opc) (commandline -ct)
  set -e words[1]
  set -l out (${program} __complete -- $words 2>/dev/null)
  if test "$out[1]" = ":dir"
    __fish_complete_directories (commandline -ct)
    return
  end
  if test "$out[1]" = ":file"
    __fish_complete_path (commandline -ct)
    return
  end
  printf '%s\\n' $out
end
complete -c ${program} -f -a '(_${fn}_complete)'
`,
  };
}
