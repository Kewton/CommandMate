# claude-first-send-4035

Live frames from Claude Code 2.1.314 (Issue #4035), captured with
`capture-pane -p -e` (ANSI intact) on a private tmux socket (`tmux -L`) while the
real `startClaudeSession` + `sendMessageToClaude` started a session and sent the
launch-worker `INIT_MESSAGE` straight away. Trailing blank rows are trimmed; the
sandbox repository path in the banner is replaced with `/tmp/p4035/repos/<id>`.

| file | when | `classifySubmit` (INIT_MESSAGE) |
|---|---|---|
| `starting-no-composer.ansi` | the session is still drawing, before the prompt | B-absent |
| `placeholder-after-enter.ansi` | the read-back after the first Enter of an unsent send: the composer still shows the dim (`SGR 2`) `Try "…"` placeholder | F |
| `late-body.ansi` | 0.9 s after that Enter: the typed body appears in the composer in plain text, unsent; it stays there until the next send clears it | D |
| `generating.ansi` | a send that was submitted: the read-back while Claude runs the `UserPromptSubmit` hook | A |
| `idle-after-reply.ansi` | the same session after its reply: empty composer | B-empty |

What was measured (2026-10-31, 32 sessions; `UserPromptSubmit` received by a
listener on the hook URL):

- Condition L (launch-worker): `.claude/settings.local.json` with
  `"model": "opus[1m]"` written right before the start. 3 of 17 first sends
  were not submitted (2 of 12 with four sessions started at once, 1 of 4 one at
  a time, 0 of 1 alone).
- Condition C (control, no settings file): 0 of 15 (12 parallel, 3 one at a
  time).
- Every unsent one was classified `submitted` by rule **F** on the first
  read-back (the dim placeholder read as composer text); none by B. The body was
  drawn 0.9–1.7 s after Enter, and the next send cleared it in one pass
  (`pre-send-composer-cleared`, `ghost`, 82 characters). No `UserPromptSubmit`
  arrived for it.
- Submitted first sends reported `UserPromptSubmit` 0.66–0.74 s after the send
  began (29 of 29).
- The 12-pass "not cleared" shape of the issue did not occur in these runs; the
  tests reproduce it by holding `late-body.ansi` through every clear pass.
