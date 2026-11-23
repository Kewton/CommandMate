# orchestrate-monitor-4532 — synthetic panes for the monitor's ending table

Read by `tests/unit/skills/orchestrate-monitor/monitor-pane-matrix-4532.test.ts`
(Issue #4532, invariant N0): Command Code・claude・codex × the three endings
(return line `DONE:` / `WAIT:` / `STOP:`, a permission prompt, `IMPL_COMPLETED`).

**All three files are synthetic** (no new live capture was taken). Each one is
an existing live fixture with rows replaced, so the bytes around the ending —
ANSI, the composer, the blank canvas — are the real tool's. ANSI is kept on
purpose: the monitor normalizes it, and a stripped fixture would hide that step.

Every file has exactly one row containing `@@REPLY@@`. The test replaces that
row with one row per reply line (the tool's own reply marker on the first one,
a two-space continuation on the rest), keeping whatever the row carries after
the placeholder (claude's panel column).

## `claude-diff-panel-synthetic.txt` — the diff panel on the right (review r4 P1-B)

- Base: `tests/fixtures/claude-live-2247/turn-version-v12.txt` (Claude Code
  v2.1.258, 200x1000, live).
- Kept: rows 1-5 (banner), the `✻ Cogitated …` row (base row 17), rows 997-1000
  (the composer and the status row).
- Replaced: the transcript between them. A new user echo (`❯ #4532 を実装する`,
  base row 13's ANSI), an `⏺ Update(…)` tool row and its `⎿` result, and the
  `@@REPLY@@` row. Every one of these rows is padded with spaces and followed by
  `ESC[38;5;244m│ESC[39m <panel text>` — the shape claude 2.1.330 draws while
  its "N files edited (show)" panel is open (`<left column><blanks>│ <panel>`).
  No 2.1.330 capture is in the repository; the panel column is synthetic.
- The panel column quotes `DONE: …`, `WAIT: …` and `STOP: …` lines on purpose,
  some below the reply: they are panel text, never an ending (invariant N2).

## `codex-split-canvas-synthetic.txt` — the split canvas (#3946, review r3 P1-A)

- Base: `tests/fixtures/codex-live-2310/saturated-idle-tail.txt` (codex v0.153.4,
  live).
- Kept: rows 37-47 (the header box, the tip, the usage notice), the composer and
  the status row (base rows 58-60).
- Replaced: the shell prompt row (base row 36) is dropped; the echo (base row 50,
  same ANSI) reads `› #4532 を実装する`; the reply rows (base rows 53-55) are the
  `@@REPLY@@` row. Blank rows are inserted between the transcript and the
  composer so the file is 1000 rows, the canvas codex draws with the transcript
  at the TOP and the composer at the BOTTOM.

## `command-code-top-anchored-synthetic.txt` — drawn from the top (#4245, #4434)

- Base: `tests/fixtures/command-code-live-2250/turn-done-1490.txt` (Command Code
  v1.49.0, 200x1000, live).
- Replaced: the echo text on row 13 (`Print exactly the line: …` →
  `#4532 を実装する`, ANSI kept) and the reply row 17 (`⠶ PROBE-2304-OK`) is the
  `@@REPLY@@` row. Everything else, including the ~976 blank rows under the
  composer, is the base's.

## The prompt column

Not synthetic: the test reads the existing live dialogs directly —
`command-code-live-2250/dialog-shell-command.txt`,
`codex-live-2310/dialog-permissions-picker.txt` — and, for claude, the dialog
rows of `tests/unit/skills/orchestrate-monitor/fixtures/prompt-yes-no.json`
placed in the `@@REPLY@@` row of the panel file above.
