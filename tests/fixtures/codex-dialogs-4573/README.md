# codex-dialogs-4573 — an approval dialog under a stale composer (synthetic)

Read by `tests/unit/lib/detection/codex-stale-composer-approval-4573.test.ts`
(Issue #4573, event 1) and listed in the codex verdict corpus.

**Both files are synthetic.** They are the S10 acceptance judge's fake codex
screens (`codex-idle.txt` and `codex-permission.txt`, banner
`OpenAI Codex (v0.153.2, judge fake)`), which the judge wrote after the real
capture `tests/fixtures/codex-dialogs-0155/dialog-approval-run-command.txt`.
No real codex was run for them. On those screens `capture --json` answered
`running / thinking_indicator` and `wait --on-prompt human` stayed
`prompt=false` for 40 s, twice.

## Shape

The two screens are stacked the way tmux keeps them after codex clears the
screen (`\e[2J`): the idle screen that was on the pane stays in the history,
and the visible part below it is the approval dialog.

| rows | from | what |
|---|---|---|
| 1-12 | `codex-idle.txt` (as written, ANSI kept) | banner, a finished turn, the composer `ESC[1m›ESC[0m ESC[2mAsk Codex to do anything ESC[0m`, the status bar `gpt-5.6-sol default · ~/accrepo-feature-a` |
| 13- | `codex-permission.txt` (as written, no ANSI) | banner, the user echo, `• Running git push origin feature/x`, `Would you like to run the following command?`, `› 1. Yes, proceed (y)` … `Press enter to confirm or esc to cancel` |

- `stale-composer-approval-padded.txt`: the visible part padded with empty
  rows to 1000 rows (a 1000-row pane, like the real captures). 1012 rows.
- `stale-composer-approval.txt`: the same without the padding. 35 rows.

Nothing was edited in the two screens. Before copying, both were read in full:
no token, credential, user name or absolute home path is in them (the only
path is `~/accrepo-feature-a`, the judge's throwaway repository).

## Verdicts (raw / after stripAnsi)

| file | before #4573 | after |
|---|---|---|
| `stale-composer-approval-padded.txt` | `running / thinking_indicator` / `waiting / prompt_detected` | `waiting / prompt_detected` (both) |
| `stale-composer-approval.txt` | `running / thinking_indicator` / `waiting / prompt_detected` | `waiting / prompt_detected` (both) |
