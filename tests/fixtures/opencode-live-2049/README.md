# opencode-live-2049 — raw opencode 1.18.22 frames for display compaction

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/opencode-terminal-compaction-2049.test.ts` (Issue #2049).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing or the trailing spaces out of them.** The whole subject of Issue #2049
is which visually-blank rows a display-only compactor may drop, and the only
thing separating opencode's painted panel rows from layout padding is the SGR
background they carry and the columns of spaces they paint. A fixture with the
escapes normalised away would let a compactor that deletes the palette's top
band pass every assertion here. The first test in the suite asserts the raw
bytes are still present and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-26 |
| Agent | opencode **1.18.22** (model `Claude Sonnet 4.6`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Isolation | disposable `HOME` per `docs/design/opencode-server-live-verification.md` §4, verified with `GET /path` before any keystroke |
| Session | `oc2049` on a private tmux socket (`tmux -L cmate-2049-oc`), over a throwaway git directory, `kill-session -t '=oc2049:'` afterwards |
| Command | `tmux -L cmate-2049-oc capture-pane -p -e -t '=oc2049:0.0' -S -0 -E -` |

The model picker was **never opened** — opencode rewrites the default model from
its picker, the same trap Claude's `/model` overlay has. `command-palette-11822`
covers the identical panel chrome (`ctrl+p` is a read-only command list) and was
closed with `Esc`.

## Frames

| File | What is on the pane | What it pins |
|---|---|---|
| `boot-idle-11822.txt` | the banner and the empty composer, nothing sent yet | 185 padding rows around a 4-row composer: the frame compacts 201 → 16 rows |
| `two-turn-idle-11822.txt` | two finished turns (`ls -la`, then a file write), composer idle at the bottom | 24 `┃` gutter rows and the `╹▀▀▀…` separator survive compaction (they carry glyphs, so they were never blank) |
| `command-palette-11822.txt` | the real `ctrl+p` overlay open over the composer | **the frame this Issue exists for** — 8 background-painted panel rows that are visually blank. Issue #1172's rule keeps 7 of 8; the #2049 rule keeps 8 of 8 |

## The measurement behind the rule

Every visually-blank row in every opencode capture in this repository falls into
exactly one of three buckets:

| bucket | example row | count | meaning |
|---|---|---|---|
| no columns, no SGR | `''` | 114–188 per frame | layout padding |
| no columns, background SGR | `ESC[38;2;255;255;255m ESC[48;2;4;4;4m` | exactly 1 per frame | the frame's colour init |
| **columns of spaces + background SGR** | `ESC[48;2;20;20;20m` + 70 spaces + `ESC[48;2;4;4;4m` | 8–9, overlay frames only | panel body |

"columns of spaces but no background" never occurs. That is the whole basis for
`isPaintedPanelRow()`: a blank row that actually paints columns with a
background colour is structure, not padding.

## What was NOT captured

opencode 1.18.22 under this isolated config ran both a shell command (`ls -la`)
and a file write **without raising a permission dialog**, so there is no 1.18.22
approval-dialog frame here. The suite therefore asserts the approval-dialog rows
against the existing verbatim 1.18.20/1.18.21 captures in
`tests/unit/lib/detection/fixtures/opencode-live-1893/` and
`…/opencode-live-1896/permission-over-numbered.txt`. Those rows carry the `┃`
gutter glyph, so they are not blank under any version of the rule — which is
what the suite asserts rather than assumes.
