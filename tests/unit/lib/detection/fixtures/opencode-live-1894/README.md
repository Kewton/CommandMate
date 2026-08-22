# opencode-live-1894 — raw frames of opencode's two-press interrupt

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-opencode-interrupt-1894.test.ts` (Issue #1894).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** The frames are read by `detectSessionStatus`, which
matches `OPENCODE_PERMISSION_PATTERN` and `OPENCODE_IDLE_COMPOSER_PATTERN`
against the gutter (`┃`, U+2503) *before* `stripBoxDrawing` runs; a normalised
fixture would change which branch each frame reaches and quietly weaken every
assertion in the suite. The first test in the file asserts the raw bytes are
still there.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | opencode 1.18.21 (model `GPT-5.6 Luna`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Session | `oc1894` on a private tmux socket (`tmux -L cm1894`), over a throwaway scratch directory, killed afterwards |
| Command | `tmux -L cm1894 capture-pane -t '=oc1894:' -p -e -S -0 -E -` |

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `esc-again-window.txt` | Mid-generation, 1.08 s after ONE Escape. Footer reads `⬝■■■■■■⬝  esc again to interrupt         7.2K (1%) · $0.00  ctrl+p commands`. No completion marker and no thinking row anywhere near the tail | `running` / `opencode_processing_indicator`, `statusEvidence: 'positive'` |
| `esc-again-after-marker.txt` | The same window 0.8 s after an Escape sent 1.6 s into a turn, so the PREVIOUS turn's genuine `▣  Build · GPT-5.6 Luna · 16.3s` is still in the tail window together with the new echo block and a `⠦ Thinking:` row | `running` / `opencode_processing_indicator`; `isOpenCodeComplete` **false** |
| `double-esc-interrupted.txt` | The pane after two Escapes 0.594 s apart: the answer stops mid-sentence and opencode writes `▣  Build · GPT-5.6 Luna · interrupted` | no completion marker claimed (`· interrupted` is not a duration) |

## What was measured (not assumed)

Three separate turns were driven on the private socket. In every one, a **single**
Escape 1.6–6 s into the generation did nothing except re-label the footer, and
the turn ran to a natural completion — `· 11.3s`, `· 16.3s`, `· 19.0s`. The
default `BaseCLITool.interrupt()` (one Escape) has therefore never interrupted an
opencode session.

Sampling the footer every ~360 ms after one Escape:

```
t=0.31  ⬝■■■■■■⬝  esc again to interrupt
t=0.67  ⬝⬝⬝⬝⬝⬝⬝⬝  esc again to interrupt
...
t=4.71  ⬝■■■■■■⬝  esc again to interrupt
t=5.07  ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt              <- window closed
```

So the second press has a **five-second** deadline, which is what
`OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS` (300 ms) is sized against.

Two Escapes inside the window abort the turn. Confirmed twice: once from a shell
harness (594 ms apart, `double-esc-interrupted.txt`) and once by calling the real
`OpenCodeTool.interrupt()` against a live session with `TMUX` pointed at the
private socket — the whole call took 317 ms end to end and left the same
`▣  Build · GPT-5.6 Luna · interrupted` mid-sentence.

## Where the Issue's own repro differs from the measurement

Issue #1894 reports the five-second window publishing
`ready` / `opencode_response_complete` via a mid-turn `▣` marker. That was **not
reproducible** on 1.18.21: a single-step turn draws no duration-carrying `▣`
while it is running (a 19 s turn that used the read tool was sampled every
~360 ms and produced its first duration-carrying marker only after the footer had
already gone idle), and the frames where a duration-carrying marker IS in the
tail window are the ones that also carry a `⠦ Thinking:` row, which branch B
catches first.

What the window actually produced, measured on `esc-again-window.txt`, is **no
evidence at all**: `running` / `default` while the frame is fresh, and
`ready` / `no_recent_output` once the poller's `lastOutputTimestamp` ages past
`STALE_OUTPUT_THRESHOLD_MS`. Both are `statusEvidence: 'none'`
(`deriveScraperEvidence`), and the second one is a false completion — the same
harm the Issue reports, reached through the staleness fallback rather than
through the completion marker. The suite pins both halves by deleting the busy
row from the real capture and asserting the pre-fix verdicts come back.
