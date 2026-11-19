# claude-first-send-4476

Frames behind `tests/unit/lib/detection/composer-text-4476.test.ts` (Issue #4476).
Neither is a new live capture: each is a measured frame with one composer row
replaced by the bytes the Issue reports. ANSI attributes are intact on purpose
(the dim `ESC[2m` is what the readers decide on); do not strip them.

| file | made from | the composer row |
|---|---|---|
| `ghost-try-logging.ansi` | `tests/unit/lib/detection/fixtures/claude-live-1879/composer-ghost-suggestion.txt` (Claude Code v2.1.238, 200x1000) | `ESC[39m❯<NBSP>ESC[2mTry "create a util logging.py that…"ESC[0m` — the raw bytes in the Issue (Claude Code v2.1.327) |
| `pasted-26-lines.capture` | `tests/fixtures/long-body-2464/claude-pasted-30-lines.capture` (claude 2.1.268, `capture-pane -p -e -S -12`) | `ESC[39m❯<NBSP>[Pasted text #1 +26 lines]` — the placeholder of the Issue comment (a 27-line body) |

The extensions are not `.txt` so the sweeps over every committed `.txt` capture
(`tests/unit/lib/chat/dialog-frame-2326.test.ts`, `tests/unit/detection/tool-liveness-3191.test.ts`)
do not pick them up.

What they pin (stage 1 of the Issue, reproduced on the production build
47a03b7c0 and on develop): the dim hint is an EMPTY composer for every reader
the clear goes through, and the paste placeholder is a composer HOLDING the
body for every reader the send goes through. The 12-pass `composer-not-empty`
of the Issue held the starting message itself (server log `remainingText`), not
this hint.
