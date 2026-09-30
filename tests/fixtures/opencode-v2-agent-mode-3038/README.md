# OpenCode V2 agent-row fixtures (Issue #3038)

Captured on 2026-09-30 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`), pane
80x200, with `HOME` and every `XDG_*` directory pointed at a throw-away
directory and a throw-away git repository as the worktree. Captured with
`capture-pane -e -p` (ANSI intact). The server, the TUI, the socket and the
temporary directories were removed afterwards.

The footer's working-directory cell was shortened to `/…/tmp/probe/repo`.
Nothing else was edited, except where the table says "derived".

| File | What | Provenance |
|---|---|---|
| `home-build.txt` | home screen right after launch: `┃  Build · LongCat 2.5 Preview Free OpenCode Zen`, 4th non-blank row from the bottom (under it: `╹▀▀▀`, the footer, `2.0.18`) | measured |
| `home-plan.txt` | the same screen after one `BTab`: `┃  Plan · …` | measured |
| `session-build.txt` | after one turn (`Reply with exactly … OK`): the completion row `     Build · <model> · 4.9s · 8.1 tok/s` in the transcript, and the agent row `┃  Build · …` 3rd from the bottom | measured |
| `session-plan.txt` | the same session after one `BTab`: `┃  Plan · …` | measured |
| `session-palette.txt` | `ctrl+p` over the Build session: the Commands palette is an overlay, the composer and its agent row stay drawn | measured |
| `session-question.txt` | the `question` tool's dialog (`Questions` / `1. Red` / `2. Blue` / `↑↓ select  enter submit  esc dismiss`): it replaces the composer, so there is no agent row | measured |
| `completion-row-only.txt` | `session-build.txt` cut right after the completion row — the negative control: a frame whose last row names `Build` but is not the agent row | derived |

On 2.0.18 the completion row has no leading glyph at all (v1 drew `▣` there),
so what keeps it out is the `┃` the agent row requires.

`Tab` changes nothing on either screen; `shift+tab` toggles Build ⇄ Plan and a
second press returns to Build.
