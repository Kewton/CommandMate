# antigravity-receipt-pair-3881 — agy's receipt-backed reply list and its approval

Issue #3881 (the second half, finding 8): a paired fixture read with the same
agy `PreToolUse` hook receipt in hand, so the only difference between the two
is what the screen shows.

| file | what it is | expected on the answering entry (receipt scope) |
|---|---|---|
| `permission-dialog.txt` | byte-for-byte copy of `antigravity-live-2364/dialog-bash-oneline.txt` (agy 1.1.27, 200x1000, live): `Requesting permission for:`, `Do you want to proceed?`, `> 1. Yes` … `4. No`, `↑/↓ Navigate · tab Amend` | read by agy's reader; Auto-Yes answers `1` |
| `reply-list.txt` | the same capture's first 24 rows (banner, the earlier turns, the `● Bash(…)` row), then — in place of the panel — the tool's output under `⎿` and agy's reply: a question and a plain `1.` / `2.` / `3.` list with no `>` cursor, no permission heading and no footer, padded to 1000 rows like the original | no prompt: the receipt alone does not vouch for it |

`reply-list.txt` is **constructed**, not captured: no live agy capture of a
reply's numbered list with a receipt is in the repository. It is used only on
the withholding side (a frame that must not be answered), never to make a
screen answerable. The rows above the panel are verbatim, ANSI included; the
reply rows carry agy's `⎿` / grey styling only where the original draws them.

Read by `tests/unit/polling/antigravity-receipt-reply-list-3881.test.ts`.
