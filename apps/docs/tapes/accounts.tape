# A text recording for the docs site: profiles, the rule of a folder and usage (Guides > Work and personal accounts).
# Render it with: pnpm build && pnpm docs:tapes accounts   (see apps/docs/scripts/render-tapes.mjs)
# Everything runs in throwaway HOMEs, like docs/demo/demo.tape.
Output apps/docs/.tmp/accounts.txt

Set Shell "bash"
Set FontSize 12
Set Width 1100
Set Height 1100
Set Padding 10
Set TypingSpeed 5ms
Set WaitPattern /turno demo .*[%$]$/
Set WaitTimeout 30s

Hide
Type "exec docs/demo/setup.sh"
Enter
Sleep 1.5s
Type "clear"
Enter
Sleep 300ms
Show

Type "turno demo" Enter
Wait
Sleep 1s

# What a few days of use leaves behind (usage snapshots), then a clean screen.
Type "turno-demo-seed && clear" Enter
Wait
Sleep 500ms

Type "turno profile list" Enter
Wait
Sleep 500ms
Type "turno profile which ~/code/acme" Enter
Wait
Sleep 500ms
Type "cd ~/code/acme && turno profile which --check; echo exit code $?" Enter
Wait
Sleep 500ms
Type "cd ~ && turno limit show" Enter
Wait
Sleep 500ms

Type "exit" Enter
Sleep 2.5s

Hide
Type `rm -rf "$TURNO_VHS"`
Enter
Sleep 300ms
