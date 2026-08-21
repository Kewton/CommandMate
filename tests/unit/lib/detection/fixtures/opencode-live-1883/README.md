# opencode-live-1883 — raw opencode TUI frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-opencode-idle-composer-1883.test.ts` (Issue #1883).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** The verdict under test is anchored on the input box's own
gutter (`┃`, U+2503): opencode paints `Ask anything...` *behind that gutter* only
while the input buffer is empty, and that is the whole difference between
positive evidence ("the composer is empty") and the inference design rule D1
forbids ("the phrase is on screen somewhere"). A fixture with the box drawing
normalised away would let a detector that reads the phrase from a response body
pass every assertion in the suite. The first test in the file asserts the raw
bytes are still there and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | opencode 1.18.20 (model `GPT-5.6 Luna`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Session | `ocprobe` on a private tmux socket (`tmux -L cm1883probe`), over a scratch directory, killed afterwards |
| Command | `tmux -L cm1883probe capture-pane -t '=ocprobe:' -p -e -S -200 -E -` |

Pane height matters here more than on the claude/codex fixture sets. opencode
anchors its input box roughly 100 rows above the bottom of the pane and fills
everything between with padding, which is why `detectSessionStatus` has an
opencode-specific content-area branch at all (Issue #473) — the generic tail
windows see only padding and the cwd footer. A frame re-captured at a default
pane height would not reproduce any of this.

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `boot-idle.txt` | A session that has just started: `┃  Ask anything... "Fix broken tests"` inside the input box, footer `tab agents  ctrl+p commands` | `ready` / `input_prompt` / `hasActivePrompt: false` — the #1883 regression |
| `composer-residual.txt` | The same frame after typing `echo PREFILLED`. The placeholder is **gone** — the row now reads `┃  echo PREFILLED` | no positive evidence: not `input_prompt`, and still `hasActivePrompt: false` |
| `turn-running.txt` | Mid-generation. Footer carries `⬝⬝⬝⬝ esc interrupt … ctrl+p commands` | `running` / `opencode_processing_indicator` |
| `turn-complete.txt` | The same turn finished: `▣  Build · GPT-5.6 Luna · 5.2s` closes the transcript | `ready` / `opencode_response_complete` |
| `phrase-in-response.txt` | opencode was asked to print the phrase. It appears **un-guttered** in the response body, and guttered-but-not-row-initial in the transcript echo of the sent message | `ready` / `opencode_response_complete`; `OPENCODE_IDLE_COMPOSER_PATTERN` must **not** match |

## What `composer-residual.txt` proves

It is the measurement behind calling the placeholder positive evidence. The two
frames differ by one action — typing — and the placeholder does not survive it:
opencode replaces the whole row rather than drawing the text over a still-visible
hint (which is what claude and codex do, and why `composer-text.ts` needs SGR
attributes to tell their ghosts from real input). So on opencode the placeholder
being *on screen* already means the buffer is empty, with no attribute reading
required.

Its second job is to document what the detector answers when the composer holds
text: nothing positive. There is no completion marker on a boot frame and no
placeholder any more, so the frame falls through to the heuristics — which is the
D1-correct answer, not an oversight.

## Why `phrase-in-response.txt` exists

`OPENCODE_PROMPT_PATTERN` (`/Ask anything\.\.\./`) matches this frame twice and
neither match is a composer. Before #1883 the status detector used exactly that
pattern over a 15-row window, so "the agent mentioned the phrase" and "the agent
is idle" were the same observation. The frame also shows why the anchor has to be
row-initial and not merely "a gutter is on this row": opencode gutters the
transcript echo of a sent message too (`┃  Output exactly this one line …`).

## The first turn eats the placeholder

Worth knowing before adding frames: on 1.18.20 `Ask anything...` appears **only
before the first response**. Afterwards the composer rows are empty (still
guttered) and the footer changes from `tab agents  ctrl+p commands` to
`<cwd>  6.4K (1%) · $ctrl+p commands`, with the cwd wrapped across three rows at
80 columns. That is why `turn-complete.txt` carries no placeholder, and why the
completion marker `▣ <Agent> · <model> · <duration>` is the only positive
evidence an idle opencode session has after its first turn.
