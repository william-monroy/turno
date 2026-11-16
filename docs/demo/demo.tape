# Regenerate with: pnpm build && vhs docs/demo/demo.tape
Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "MesloLGS Nerd Font"
Set FontSize 17
Set Width 1180
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful
Set WaitPattern /^\$$/
Set WaitTimeout 20s

Hide
Type "export REPO=$PWD DEMO=$(docs/demo/setup.sh) && export HOME=$DEMO PATH=$DEMO/.local/bin:$PATH TURNO_NO_UPDATE_CHECK=1 PS1='$ ' && (turno mcp daemon run >/dev/null 2>&1 &) && cd ~ && clear"
Enter
Sleep 2s
Show

Type "turno profile add cx --agent codex   # a Codex profile, its own login" Sleep 400ms Enter
Wait
Sleep 1.2s
Type "turno profile assign ~/code/acme work   # this repo uses the work account" Sleep 400ms Enter
Wait
Sleep 1.2s
Type "turno mcp list   # one gateway for every session of every agent" Sleep 400ms Enter
Wait
Sleep 2.2s
Type "clear && cd ~/code/acme && turno status" Sleep 400ms Enter
Wait
Sleep 3.5s
Type "clear && node $REPO/bench/mcp-ram.mjs --show $REPO/bench/results/2026-11-16-m3-16gb-8-sessions.json" Sleep 400ms Enter
Wait
Sleep 5s

Hide
Type "pkill -f 'turno-demo' ; true" Enter
