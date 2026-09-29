# OpenCode V2 model keys, measured for the dialog card (Issue #2983)

Captured on 2026-09-29 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`), pane
80x200, in a throwaway git repository. `HOME` and `XDG_CONFIG_HOME` /
`XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed at a scratch
directory (`env -i`). Keys were sent with `tmux send-keys`, one entry at a time,
100 ms apart — the spacing `sendSpecialKeys()` uses. `capture-pane -S 0 -E 199`,
trailing blanks trimmed, the footer's working-directory cell shortened to
`/…/tmp/probe/repo`. Nothing else was edited (the model list shows the free
models plus whatever local providers the machine advertised). The server
default model was `LongCat 2.5 Preview Free` (no variants); `Space Bunny Free`
was picked through the model picker to get one that has variants.

| File | What |
|---|---|
| `home.txt` | the launch screen: no dialog (reads `ready`) |
| `select-model-ctrl-x-m.txt` | `ctrl+x m` from home: `Select model … esc` |
| `commands-ctrl-p.txt` | `ctrl+p` from home: `Commands … esc` (lists `Switch model ctrl+x m`, `Variant cycle ctrl+t`) |
| `space-bunny-variant-dialog.txt` | picking `Space Bunny Free` opens `Select variant … esc` |
| `variant-default.txt` | after `Enter` on `Default`: model bar `… OpenCode Zen` |
| `variant-ctrl-t-1.txt` | `ctrl+t` from home: model bar `… OpenCode Zen · low` (variant cycled) |
| `model-then-ctrl-p.txt` | `ctrl+p` INSIDE `Select model`: nothing changes, the picker stays |
| `model-then-ctrl-t.txt` | `ctrl+t` INSIDE `Select model`: nothing changes |
| `palette-then-ctrl-t.txt` | `ctrl+t` INSIDE `Commands`: nothing changes |
| `palette-then-ctrl-x-m.txt` | `ctrl+x m` INSIDE `Commands`: `m` is typed into the palette's filter |
| `palette-esc-then-models.txt` | `Escape`, `ctrl+x m` from inside `Commands`: `Select model` opens |
| `models-esc-then-commands.txt` | `Escape`, `ctrl+p` from inside `Select model`: `Commands` opens |
| `models-esc-then-variant.txt` | `Escape`, `ctrl+t` from inside `Select model`: variant `medium` → `high` |
| `home-esc-then-variant.txt` | `Escape`, `ctrl+t` from home: variant `high` → `xhigh` (the `Escape` is harmless there) |

What it decided: every picker and the palette reads as `waiting` /
`opencode_modal_overlay` (#2971), so the chat surface's dialog card IS drawn
while one is open — but none of the three model keys reaches through it. So
v2's card keys lead with `Escape`, and are drawn only when the frame has one of
these dialogs' title rows (never on #2945's approval strip or question form,
where `Escape` would be an answer).

Pinned by `tests/unit/detection/tools/opencode-v2/model-keys-dialog-2983.test.ts`,
`tests/unit/components/worktree/ChatSurface-opencode-v2-model-keys-2983.test.tsx`
and `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts`.
