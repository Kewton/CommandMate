# codex-live-2310 — the dialogs the footer whitelist missed

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/detection/codex-structural-dialog-2310.test.ts` (Issue #2310).

They sit here rather than beside the older detection frames because
`tests/unit/polling/auto-yes-dialog-gate.test.ts` walks
`tests/unit/lib/detection/fixtures/` whole and pins by name every answerable
dialog it finds — so dropping two more numbered dialogs into that tree would
rewrite another suite's control list as a side effect of capturing a frame.

**These files are raw on purpose. Do not strip ANSI from them.** The whole point
of the Issue is that codex draws `›` (U+203A) at column 0 for three different
things and only the SGR attributes tell them apart. A stripped fixture would let
a detector that reads every `›` as the composer pass the whole suite — which is
precisely the defect being fixed. The test file asserts the escape sequences are
still present and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-09-04 |
| Agent | codex-cli 0.153.2 (model `gpt-5.6-sol`, `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`) |
| Pane geometry | 200x1000 (production layout) |
| Session | `probe` on a private tmux socket (`tmux -L cm2310`), disposable `HOME`, a scratch git repo as cwd; server killed and the copied credential removed afterwards |
| Command | `tmux capture-pane -p -e -t probe` |

## The frames

| File | Screen | Footer | Before #2310 | After |
|---|---|---|---|---|
| `dialog-experimental-toggles.txt` | `/experimental` | `Press space to select or enter to save for next conversation` | **`ready`** | `waiting` / `codex_selection_list` |
| `dialog-keymap-editor.txt` | `/keymap` | `left/right group · enter edit shortcut · * custom · - unbound · esc close` | **`ready`** | `waiting` / `codex_selection_list` |
| `dialog-permissions-picker.txt` | `/permissions` | `Press enter to confirm or esc to go back` | `waiting` / `codex_selection_list` | unchanged |
| `dialog-trust-directory.txt` | directory trust, first launch | `Press enter to continue` | `waiting` / `prompt_detected` | unchanged |
| `idle-composer.txt` | idle, empty composer | *(model/cwd status bar)* | `ready` | unchanged |
| `turn-running.txt` | generating, composer still drawn | *(status bar; `Working (7s · esc to interrupt)` above)* | `running` | unchanged |

The first two rows are the defect. Both screens are blocked on a keypress and
both were reported `ready`, which is what made Auto-Yes see nothing to answer,
the sidebar dot go green, and `commandmate wait` close on `scraper_ready` while
the operator's session had not moved.

The last four rows are the negative controls that any fix has to keep: two
dialogs that already resolved correctly (so the fix must not re-classify them)
and the two idle/running frames whose bottom-most `›` is the composer (so the
fix must not turn a live session yellow — the #1883 shape, where an over-eager
`waiting` closed the send guard on every send).

## The `›` rows, verbatim

This is the measurement the rules rest on. `cat -v`, with `^[` for ESC:

| Frame | Row | Kind |
|---|---|---|
| `dialog-experimental-toggles.txt` | `^[[1m^[[38;5;6m› [ ] Network proxy                Apply network proxy…^[[0m` | option — bold label |
| `dialog-keymap-editor.txt` | `^[[1m^[[38;5;6m› Global       - Open Agents                unbound^[[0m` | option — bold label |
| `dialog-permissions-picker.txt` | `^[[1m^[[38;5;6m› 1. Ask for approval (current)  Codex can read and edit…^[[0m` | option — bold label |
| `dialog-trust-directory.txt` | `^[[38;5;6m› 1. Yes, continue^[[39m` | option — **not bold**; recognised by the coloured glyph |
| `idle-composer.txt` | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | composer — bold glyph, plain (dim) label |
| `turn-running.txt` row 13 | `^[[1;2m› ^[[0mRun the shell command: sleep 25…` | transcript echo — dim glyph |
| `turn-running.txt` row 21 | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | composer — the bottom-most `›`, which is why the frame reads `running` and not `waiting` |

`dialog-trust-directory.txt` is why the rule recognises an option **positively**
(bold label OR coloured glyph) instead of defining it as "not the composer": its
option row is neither bold nor dim, so a rule phrased the other way round would
have to guess, and guessing wrong on an idle composer is the expensive direction.

## Neither leaking list is numbered

Both `/experimental` and `/keymap` draw their choices without `1. / 2. / 3.`, so
`findNumberedOptionBlock` — the reader every tool's `prompt.ts` uses — finds
nothing on either frame. That is why `readCodexDialogFrame` leads with the
attribute rule and keeps the numbered block as its second, `stripAnsi`-surviving
reading rather than the other way round.

## What these frames do NOT cover

An ANSI-stripped capture of the two leaking frames still reads `ready`: the lists
are unnumbered, so neither reading has anything left to work with once the
attributes are gone. That path is Auto-Yes's `captureAndCleanOutput`, which does
not publish session status, and the suite pins the limit explicitly rather than
leaving it to be discovered.
