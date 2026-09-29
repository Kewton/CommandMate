# claude 2.1.284 — SessionStart payload and startup banner (Issue #2955)

Captured 2026-09-29 on claude 2.1.284, interactive session started with
`claude --settings <probe> --model sonnet` on a private tmux socket
(`tmux -L <socket>`), in a worktree that was already trusted. The probe's
`SessionStart` hook was `type: "command"` running `cat > <file>`, so the payload
is byte-for-byte what claude writes on the hook's stdin.

| file | what it is |
|------|------------|
| `session-start-2.1.284.json` | the `SessionStart` stdin payload. Paths and the session id replaced with placeholders; everything else verbatim |
| `banner-2.1.284.txt` | `tmux capture-pane -p` of the same session right after start. Only the cwd line was replaced (`~/repo`) |

What the two show:

- The payload **does** carry `"model": "claude-sonnet-5-5"`. The value is lost
  downstream: CommandMate delivers `SessionStart` through
  `scripts/hooks/cmate-agent-event.sh` (http is not supported for that event),
  and the script rebuilds the body from a fixed list of keys that has no `model`.
- The banner no longer reads `<model> with <effort> effort · <plan>` (2.1.232,
  `CLAUDE_STARTUP_BANNER_PATTERN`). It is `Sonnet 5.5 · Claude Max`, and the
  effort moved to a separate right-aligned row (`◐ medium · /effort`, seen on
  the first frame; by the time of this capture a `tmux detected · …` notice had
  replaced it on the same row). The frame
  reader requires `with <effort> effort`, so it reads nothing either.

A `claude -p` run of the same probe emitted a `SessionStart` **without** `model`
(and without `scratchpad_dir`); only the interactive session carries it.

Both were fixed in #2955: the relay forwards `model` on `session_start`, and
`CLAUDE_STARTUP_BANNER_V2_1_28X_PATTERN` / `CLAUDE_EFFORT_ROW_PATTERN` read the
new banner and effort row.
