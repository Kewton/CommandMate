# codex-browser-use-2609 — codex's tool-call approval form

Used by `tests/unit/lib/detection/codex-browser-use-approval-2609.test.ts`
(Issue #2609).

## Provenance

| | |
|---|---|
| Observed | 2026-09-17, twice in the same codex session |
| Agent | codex-cli (the build was not recorded in the report) |
| Source | the frame as quoted in Issue #2609 — **text, not a `capture-pane -e` capture** |

The Issue reported the screen as plain text, so this fixture has no ANSI. That
is enough for what it pins: `detectCodexDialog` (the rule `/prompt-response`
and Auto-Yes consult) reads `frame.clean`, the ANSI-stripped spelling, so its
verdict does not depend on the attributes. A raw re-capture should replace this
file when one is taken; keep the name so the test keeps pointing at it.

It sits under `tests/fixtures/` rather than
`tests/unit/lib/detection/fixtures/` for the reason `codex-live-2310/README.md`
gives: `tests/unit/polling/auto-yes-dialog-gate.test.ts` and
`tests/unit/polling/dialog-presence-gate-2457.test.ts` walk that other tree and
pin every answerable dialog in it by name.

## The frame

| File | Screen | Footer | Before #2609 | After |
|---|---|---|---|---|
| `approval-form-browser-use.txt` | `Allow Browser use to access …?` (`Field 1/1`) | `enter to submit \| esc to cancel` | status `waiting` / `prompt_detected`, but `detectCodexDialog` → `null`: `respond` refused with `prompt_no_longer_active`, Auto-Yes suppressed with `unclassified-frame` | `detectCodexDialog` → `permission` / `numbered`, 3 options |

Pressing Enter once in the pane resumed the session, so the dialog was real,
not a false positive.
