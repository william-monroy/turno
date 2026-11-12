---
name: fork-session
description: Gives the exact command to fork the current Claude Code session into a new one under the turno profile the user picks (or auto), without closing this one. Use it when the user says "fork this session", "duplicate this conversation", "open this session in another terminal or account without closing it", or invokes /fork-session <profile>.
---

# Fork this session

A fork opens a NEW session that starts with the whole conversation so far and then goes its own
way with its own id. This session keeps running: both stay alive in parallel. It runs as
`turno <profile> --resume <id> --fork-session` **from the folder where the session started**,
because `claude --resume` looks sessions up by the folder it is launched from. To move the session
and close this one, use the switch-account skill instead.

## Steps

1. **Profile.** It is the argument (`/fork-session personal`) or what the user said. Any turno
   profile works, and so does `auto` (the profile assigned to the project). The same profile as the
   current one is fine: the fork is a different session. If they did not say, run `turno session handoff`
   with no argument to list the profiles, and ask only when more than one choice is reasonable.
2. **The command.** Run:

   ```bash
   turno session handoff <profile> --fork --copy
   ```

   It prints `cd <folder> && turno <profile> --resume <id> --fork-session` and copies it. Repeat
   any `warning:` line to the user as is. If it fails, report the error; never improvise the command.
3. **What does not travel.** Background commands, agents, monitors and agent worktrees stay with
   THIS session and report here, not to the fork. Say so if the fork is meant to continue that
   work, or say there is none. Also mention it when the work in progress is in a different folder
   from where the fork will start.

## Reply

Short:

- Paste it in a NEW terminal tab or window; no `/exit` here.
- The command in a code block (already on the clipboard).
- One line on why the `cd` comes first when the session started in another folder.
- From now on the two sessions diverge; they should not edit the same branch or files at once.
- What keeps running here and does not travel to the fork, or that nothing does.
