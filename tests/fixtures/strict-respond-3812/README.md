# strict-respond-3812 — agy's command permission dialog under the strict respond (Issue #3812)

Read by `tests/unit/lib/prompt-observation/strict-respond-3812.test.ts`. The directory
name does not start with a tool id for the reason `prompt-observation-3755/README.md`
gives (the dialog-gate suites walk every `<tool>-*` directory as their corpus).

All three files come from the #3796 / #3797 UAT (2026-10-19, item F of
`uat-3796.md`): an isolated CommandMate server, agy in an already-trusted folder,
Auto-Yes off, asked to run `pwd`. **Every byte is verbatim** — nothing in them is
private (the worktree id `uat-agyfresh` is the UAT's own scratch worktree).

| file | what it is | how it was read |
|---|---|---|
| `permission-run-command.txt` | the dialog as it opened: `Run this command?` over `> 1. Yes, run command` / `2. Yes, and always allow in this conversation …` / `3. Yes, and always allow … (Persist to settings.json)` / `4. No, cancel`, footer `↑/↓ Navigate · tab Amend · ctrl+g edit/expand command`. ANSI kept (the `>` row is drawn in `\x1b[94m`) | `commandmate capture <wt> --instance antigravity --pane` (the pane's last rows) |
| `observation-highlight-1.json` | `commandmate prompt --instance antigravity --json` on that dialog: `selectedPosition` 1 | the server's own observation |
| `observation-highlight-2.json` | the same after the strict respond's one `Down` (it stopped there, exit 41 `screen_moved_mid_send`): `selectedPosition` 2 | the server's own observation |

The two observations differ in the token, `observedAt`, `selectedPosition` — and in
`approvalTarget`, whose option rows carry the `>` (`> 1. Yes, run command` became
`  1. Yes, run command`, `  2. …` became `> 2. …`), and in `appearedAt`: the server
took the moved cursor for a new appearance of the screen. That is the cause the
suite pins: the highlight reached the token binding and the appearance fingerprint
through `approvalTarget`, so every `Down` read as "the screen moved".

The frames after a `Down` that the suite feeds the fake pane are made from
`permission-run-command.txt` by moving the `\x1b[94m> ` gutter to another row — the
move the second observation shows agy made. No other byte is changed.
