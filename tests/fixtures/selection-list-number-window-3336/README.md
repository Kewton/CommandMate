# selection-list-number-window-3336 — a numbered reply above a dialog with no numbers

One frame, and it is **derived, not captured**: two existing live captures
combined, so the trap Issue #3336 describes is on a real opencode screen.

| | |
|---|---|
| Base | `../opencode-live-2046/w80/dialog-agent-list.txt` (live opencode 1.18.22, 80x200, `Select agent` overlay open — no numbers on it) |
| Added | rows 34–36 of `../opencode-live-2047/w80/numbered-answer.txt` (the same opencode build's reply `1. Yes` / `2. No` / `3. Cancel`, ANSI intact) |
| Where | rows 184–186 of the base, which were empty. Same row count (200); every other row is the base's, byte for byte |

That is where a long session's latest reply sits on opencode's 80x200 pane:
the transcript fills down to just above the composer (row 191), so a numbered
answer ends up within 40 rows of the bottom while the overlay is drawn
mid-pane.

## What it pins

- `readSelectionListShape` reads the last 40 content rows and counts the
  reply's `1.`…`3.` — before #3336 the number row `1` `2` `3` was drawn under
  `Select agent`, on the chat card and (since #3305) the terminal surface.
- The card draws `extractDialogFrameTail(frame, { selectionList: true })`,
  which `extractOpenCodeModalOverlayFrame` crops to the overlay. Counting on
  that gives 0.

Pinned by `tests/unit/lib/session/selection-list-ops-3336.test.ts` and
`tests/unit/components/worktree/selection-list-keys-3336.test.tsx`.
