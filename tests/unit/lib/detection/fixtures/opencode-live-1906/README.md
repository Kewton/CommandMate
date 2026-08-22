# opencode-live-1906 — raw opencode TUI frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/cli-tools/submit-verified-sender-opencode-1906.test.ts` (Issue #1906).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** The verdict under test is `classifySubmit`'s opencode
branch, which locates the input box by its own gutter (`┃`, U+2503) and bottom
border (`╹▀▀▀`, U+2579) because opencode draws no `>` / `❯` / `›` prompt marker
anywhere. A fixture with the box drawing normalised away would let the old,
marker-only reader — the one that answered `submitted` for every opencode send
without ever seeing the composer — pass every assertion here.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | opencode 1.18.21 (model `GPT-5.6 Luna`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Session | `ocprobe` on a private tmux socket (`tmux -L cm1906`), over a scratch directory, killed afterwards |
| Command | `tmux -L cm1906 capture-pane -t '=ocprobe:' -p -e -S -200 -E -` |

Same geometry caveat as `opencode-live-1883/`: before the first turn is answered
opencode centres the whole input box under its banner — row ~100 of 200 — and
only pins it to the bottom afterwards. That is the measurement behind
`verifyCaptureLines`: a 12-row tail read of a pre-first-turn frame contains blank
padding and the cwd footer and no composer at all, which the marker reader scored
as "submitted".

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `composer-multiline-pending.txt` | A three-line message typed into the composer and **not** submitted. The box grew to one row per line; the `Build · <model>` row is still last | `pending` — resend Enter |

The single-line counterpart is `opencode-live-1883/composer-residual.txt`
(`┃  echo PREFILLED`), and the empty-composer / running / permission-dialog
frames are `opencode-live-1883/boot-idle.txt`, `turn-complete.txt`,
`turn-running.txt` and `opencode-live-1893/permission-bash.txt`. Those are reused
rather than re-captured — the shapes have not changed between 1.18.20 and
1.18.21, and a second copy is a second thing to keep in step.
