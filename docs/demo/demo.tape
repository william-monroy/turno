# The README demo. Regenerate it from the repository root with one command (after a version
# bump too, so the gif shows the new version):
#
#   pnpm build && vhs docs/demo/demo.tape
#
# It writes docs/assets/demo.gif and needs vhs (with ttyd and ffmpeg) and the MesloLGS Nerd Font
# installed for your user. Everything runs in throwaway HOMEs: setup.sh starts a shell with an
# empty environment under /tmp/turno-vhs, and `turno demo` builds the profiles, gateway and MCP
# servers it shows, then removes them on exit; the tape removes /tmp/turno-vhs at the end. Your
# own HOME, config and accounts are never read or changed, and nothing signs in: the `claude`
# on that PATH is a stand-in that only answers `claude auth status` for two example accounts,
# and turno-demo-seed (hidden) writes the usage snapshots and copies the bundled font into the
# demo HOME. Ports, pids and reset times differ between runs; everything else is the same.
Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "MesloLGS Nerd Font"
Set FontSize 16
Set Width 1180
Set Height 800
Set Padding 20
Set Framerate 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms
Set WindowBar Colorful
Set WaitPattern /turno demo .*[%$]$/
Set WaitTimeout 20s

Hide
Type "exec docs/demo/setup.sh"
Enter
Sleep 1.5s
Type "clear"
Enter
Sleep 300ms
Show

# The demo sets up two Claude Code profiles, a folder rule and a gateway, then opens a shell.
Type "turno demo" Sleep 300ms Enter
Wait
Sleep 4.5s

# What a few days of use leaves behind: usage snapshots and the font (not recorded).
Hide
Type "turno-demo-seed"
Enter
Sleep 500ms
Ctrl+L
Sleep 200ms
Show

# Bare turno: the one-screen summary.
Ctrl+L
Type "turno" Sleep 300ms Enter
Wait
Sleep 3.5s

Ctrl+L
Type "turno init --dry-run" Sleep 300ms Enter
Wait
Sleep 2s
Type "turno profile list" Sleep 300ms Enter
Wait
Sleep 2s

# A missing profile argument opens the picker: arrows move, enter chooses.
Ctrl+L
Type "turno profile assign ~/code/personal-site" Sleep 300ms Enter
Sleep 1.2s
Down Sleep 600ms
Up Sleep 700ms
Enter
Wait
Sleep 1.5s

# Doctor names the fix under every finding.
Ctrl+L
Type "turno doctor" Sleep 300ms Enter
Wait
Sleep 4s

Ctrl+L
Type "turno mcp list" Sleep 300ms Enter
Wait
Sleep 2s
Type "turno limit show" Sleep 300ms Enter
Wait
Sleep 2.5s

# Leaving the demo shell stops mcpd and removes the demo HOME.
Type "exit" Sleep 300ms Enter
Sleep 2.5s

Hide
Type `rm -rf "$TURNO_VHS"`
Enter
Sleep 300ms
