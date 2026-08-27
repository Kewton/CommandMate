# opencode-modal-overlay-2112 — the negative control for the overlay gate

One frame, and it is **derived, not captured**. Everything else Issue #2112
needed was already in the repository: `opencode-live-2046/w80/dialog-*.txt` are
the four dialogs the Issue is about, `opencode-live-2047/w{80,120,200}` are the
same palette over a busy transcript at three widths, and
`opencode-live-1896/select-model-in-response.txt` is #1896's own prose trap. What
none of them could be is a frame that says the NEW headings in the transcript,
because no live session was ever asked to say them.

## What it is

| | |
|---|---|
| Derived from | `tests/fixtures/opencode-live-2046/w80/sidebar-off.txt` (live opencode 1.18.22, 80x200, captured 2026-08-26 — see that directory's README) |
| Derived on | 2026-08-27 |
| Edits | four string substitutions, listed below. Every escape sequence, every column and every one of the 201 rows is the original capture's |

The substitutions:

1. **Row 2**, the echoed user prompt inside opencode's `┃` bubble: the message
   text is replaced, at the same length, by `Commands` + padding + `esc`.
2. **Rows 4, 5 and 6**, the assistant's reply: `Timeline`, `Sessions` and
   `Select agent`, each followed by padding and `esc`.

Row 7 — `▣  Build · Claude Sonnet 4.6 · 2.8s` — is untouched, so the frame is a
genuinely finished turn and the correct verdict for it is
`ready` / `opencode_response_complete`. A gate that fired here would not merely
be noisy: it would park a completed session on `waiting` for the rest of its
life, which is the harm #1896 measured and narrowed
`OPENCODE_SELECTION_LIST_PATTERN` to avoid.

## The two traps

Each substitution is a different way to be wrong about this frame.

- **Rows 4–6 are the word-list trap.** Each is exactly
  `<heading>  …  esc` — the shape a widened
  `OPENCODE_SELECTION_LIST_PATTERN` allowlist would match, and
  `detection-opencode-modal-overlay-2112.test.ts` asserts a widened one DOES
  match, so the control cannot quietly stop being a trap. They are ordinary
  transcript rows: no background is painted behind them, so there is no
  rectangle to read.
- **Row 2 is the layout trap.** The bubble opencode draws around an echoed
  prompt IS a background-painted rectangle — columns 3–78, three rows, and now
  with a hatch-shaped row in the middle of it. The only thing between it and a
  false `waiting` is that opencode draws the box's gutter (`┃`) in the column
  immediately left of the painted interior. That guard has a mutation test.

## Not here

- **No `ctrl+x t` (themes) or `ctrl+t` (variant cycle) frame.** Neither was
  measured — see `docs/design/opencode-modal-overlay-detection.md` §5. They are
  drawn by the same overlay code as the four dialogs that WERE measured, so the
  rule is expected to cover them, but expected is not measured.
