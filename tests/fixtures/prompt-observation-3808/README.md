# prompt-observation-3808 — agy permission dialogs whose footer is not the measured one (Issue #3808)

Read by `tests/unit/detection/tools/antigravity-permission-footer-3808.test.ts`
and `tests/unit/lib/auto-yes-login-method-3808.test.ts`. The directory name does
not start with a tool id for the reason `prompt-observation-3755/README.md`
gives (the dialog-gate suites walk every `<tool>-*` directory as their corpus).

## Provenance

**Constructed, not live captures.** Each file is
`tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt` (agy 1.1.27,
200x1000, ANSI kept) with ONLY its footer row (L38,
`↑/↓ Navigate · tab Amend · ctrl+g edit/expand command`) replaced (or, for
`-offscreen`, the rows from it down dropped). Every other
byte is the original's. They stand for "a permission dialog whose `tab Amend`
footer did not reach the screen", which nobody has captured yet: the #3797
review left the narrow-pane and other-version spellings unmeasured.

## The frames

| file | footer row(s) | stands for | expected reading |
|---|---|---|---|
| `antigravity-permission-footer-truncated.txt` | `↑/↓ Navigate · tab Am` | a pane narrow enough to cut the footer | not answered (unclassified / `unknown`) |
| `antigravity-permission-footer-wrapped.txt` | `↑/↓ Navigate · tab` / `Amend · ctrl+g edit/expand command` (one row more, the last blank row dropped) | a pane narrow enough to wrap the footer | not answered |
| `antigravity-permission-footer-other-version.txt` | `↑/↓ Navigate · enter Select` | another agy version spelling the footer differently | not answered |
| `antigravity-permission-footer-offscreen.txt` | none: L1–L37 only (L38 onward dropped, so the file is 37 rows) | a pane too short to show the footer | not answered |
| `antigravity-permission-footer-cut-at-nav.txt` | `↑/↓ Nav` | a pane narrow enough to cut the footer before `Navigate` | not answered |

The live login-method screen these share a reading with is
`prompt-observation-3797/antigravity-login-method.txt` (agy 1.4.2).
