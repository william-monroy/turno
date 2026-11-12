---
name: switch-account
description: Gives the exact command to continue the current Claude Code session under another claudio profile without losing the conversation. Use it when the user says "switch account", "move this session to the work profile", "this account ran out, give me the command", "continue this with another account", or invokes /switch-account <profile>.
---

# Continue this session under another profile

claudio profiles share conversations and memory, so a session can move to another account: exit
with `/exit` and resume it with `claudio <profile> --resume <id>` **from the folder where the
session started**. `claude --resume` looks a session up under the project of the folder it is
launched from, and a worktree does not count.

## Steps

1. **Target profile.** It is the argument (`/switch-account work`) or what the user said. If they
   did not say, run `claudio handoff` with no argument: it lists the profiles and the current one.
   Ask only when more than one choice is reasonable.
2. **The command.** Run:

   ```bash
   claudio handoff <profile> --copy
   ```

   It prints `cd <folder> && claudio <profile> --resume <id>` and copies it to the clipboard.
   Repeat any `warning:` line from stderr to the user as is. If the command fails, report its
   error; never build the command by hand.
3. **What exiting cuts off.** Check whether this session has live work: background commands,
   agents, monitors, half-done writes. `/exit` kills them. If there is any, say so and offer to wait
   for it or leave it at a resumable point first. If there is none, say that too.

## Reply

Short:

- First `/exit`, then the command in a code block (already on the clipboard).
- One line on why the `cd` comes first when the session started in a different folder.
- What is running and would be cut off, or that nothing is.
