# OpenCode V2 dialogs and numbered replies (Issue #2984)

Captured on 2026-09-29 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`), pane
80x200, in a throwaway git repository whose `opencode.json` sets
`"permission": {"edit": "ask"}`. The process ran under `env -i` with `HOME` and
`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed
at a directory made with `mkdtemp` under `os.tmpdir()`, and with the server's
default free model (`LongCat 2.5 Preview Free`). `tmux capture-pane -p -S - -E -`
(no ANSI), trailing blanks trimmed, and the footer's working-directory cell
shortened to `/…/tmp/probe/repo`. Nothing else was edited.

All frames come from ONE session, in this order, so earlier turns stay in the
scrollback of later frames.

| File | What | Poller reads it as | `detectDialog` |
|---|---|---|---|
| `numbered-reply.txt` | the #1896 prompt: a reply with `1. Cloud … / 2. On-premises … / 3. Hybrid …` and `Which one would you like?` — plain `1.` rows, no glyph | no prompt | `null` |
| `quoted-dialog-reply.txt` | a reply that is `Do you want to proceed?` / `❯ 1. Yes` / `  2. No` as plain text | **`multiple_choice`** (2 options) | `null` |
| `permission.txt` | an edit approval, `┃   Allow once   Always allow   Reject …`, with the quoted dialog above in the scrollback | no prompt | `permission`, `keys` |
| `permission-after-digit.txt` | the next approval after typing `3` with no Enter: the strip is still open — a digit does nothing to it | no prompt | `permission`, `keys` |
| `question.txt` | the question tool's form: `1. Red / 2. Blue / 3. Type your own answer` / `┃  ↑↓ select  enter submit  esc dismiss` | no prompt | `question`, `numbered`, `answer_only` |
| `question-answered-by-digit.txt` | right after typing `2` with no Enter on `question.txt`: the form closed, `Blue` was submitted, `You chose Blue.` | no prompt | `null` |
| `commands.txt` | the ctrl+p Commands palette (`Commands … esc`). A typed `1` went into its filter | no prompt | `picker`, `keys` |
| `question-under-quoted-dialog.txt` | one turn that wrote the quoted dialog and then opened the question form under it | no prompt | `question`, `numbered`, `answer_only` |

"Poller reads it as" is `detectPromptOnCleanFrame(…, 'opencode-v2')` on the
spelling `capturePollerFrame` produces. The live UAT on the same session also
read `● 1. Yes, overwrite / 2. … / 3. Cancel` written in a reply as
`multiple_choice`, refused by the gate under `enforce` and allowed under
`CM_AUTOYES_DIALOG_GATE=opencode-v2=legacy`.

Pinned by `tests/unit/detection/tools/dialogs.test.ts` (`[#2984]`) and
`tests/unit/polling/auto-yes-dialog-gate-opencode-v2-2984.test.ts`.
