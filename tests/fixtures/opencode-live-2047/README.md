# opencode-live-2047 — the same session, captured at three pane widths

Live `tmux capture-pane -p -e -S -200 -E -` captures used by
`tests/unit/detection-opencode-pane-width-fixtures-2047.test.ts` (Issue #2047).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them,** for the same reason `opencode-live-1883` says so: the
verdicts under test are anchored on the input box's gutter (`┃`, U+2503) and on
the SGR-painted background this Issue turned out to be about. The first test in
the suite asserts the raw bytes are still there.

## Why three widths of the same frames

Issue #2047 asked whether opencode's pane could be widened from the 80 columns
`launchSession()` has always pinned it to. The only way to answer that without
guessing is to put the same session state in front of the detectors at more than
one width, so **every frame here exists three times — `w80/`, `w120/`, `w200/` —
captured from one live session by resizing the window between captures**, not by
re-driving the conversation. Anything that differs between the three files
differs because of the width and nothing else.

`w80/` is a control, not a replacement: the 80-column fixtures the #1883 / #1893
/ #1894 / #1896 suites already own are untouched, and #2047's acceptance
condition is that they stay green.

## Provenance

| | |
|---|---|
| Captured | 2026-08-26 |
| Agent | opencode 1.18.22 (model `Claude Sonnet 4.6`, provider GitHub Copilot) |
| Pane geometry | 80x200, 120x200, 200x200 — height is `OPENCODE_PANE_HEIGHT` throughout |
| Harness | `docs/design/opencode-server-live-verification.md` §4: isolated `HOME` under the scratchpad, `opencode serve` on 127.0.0.1:4789, `GET /path` confirmed every resolved directory was inside it |
| Session | `ocw` on a private tmux socket (`tmux -L cmate-2047-oc`), `opencode attach`, killed with `kill-session -t '=ocw:'` afterwards |
| Command | `tmux -L cmate-2047-oc capture-pane -t '=ocw:0.0' -p -e -S -200 -E -` |
| Model picker | never opened (it rewrites the default model); the model was pinned in the isolated `opencode.jsonc` |

The harness cwd is the scratchpad path, which is ~150 characters long. That is
why the footer's cwd wraps across several rows even at 200 columns — it is a
property of the path, not of the width, and it matches the shape the
80-column fixtures already have.

## The measurement these files exist to record

**opencode 1.18.22 paints a right-hand sidebar at 121 columns and wider, and
hides it at 120 and narrower.** The boundary was walked one column at a time
(119 → no sidebar, 120 → no sidebar, 121 → sidebar) and reproduced in both
directions on the live TUI.

The sidebar does not get its own region of the capture. It shares ROWS with the
transcript, so at ≥121 columns every captured line is
`<transcript text>   …   <sidebar text>` and this repo's readers see one row.

| File | What it is | 80 vs 120 | 200 |
|---|---|---|---|
| `boot-idle.txt` | Fresh session, `┃  Ask anything...` in the input box | identical verdict | identical verdict |
| `composer-residual.txt` | The same frame after typing `echo PREFILLED` | identical | identical |
| `turn-running.txt` | Mid-generation, footer `⬝⬝⬝⬝⬝⬝⬝■  esc interrupt` | identical | identical |
| `esc-again-window.txt` | 0.35 s after ONE Escape, footer `esc again to interrupt` | identical | identical |
| `double-esc-interrupted.txt` | Two Escapes 0.6 s apart: `▣  Build · Claude Sonnet 4.6 · interrupted` | identical | identical |
| `turn-complete.txt` | `▣  Build · Claude Sonnet 4.6 · 1.9s` closes the turn | identical | identical |
| `permission-bash.txt` | `△ Permission required` / `$ uname -a` + the button strip | identical | identical |
| `permission-edit.txt` | The same dialog over an inline diff | identical | identical |
| `numbered-answer.txt` | A three-item numbered list as the reply | identical | **`OPENCODE_IDLE_COMPOSER_PATTERN` false-matches** |
| `phrase-in-response.txt` | opencode was asked to print `Ask anything...` | identical | **the extracted reply is sidebar chrome** |
| `sidebar-title-phrase.txt` | Idle, session TITLE contains `Ask anything...` | identical | **`OPENCODE_IDLE_COMPOSER_PATTERN` false-matches** |
| `turn-aborted-after-complete.txt` | Permission REJECTED, so `▣  Build · Claude Sonnet 4.6` carries no duration — with the previous turn's `· 36.1s` still 11 rows above | identical | **`ready` flips to `running`** |
| `command-palette.txt` | `ctrl+p` palette open over the transcript | identical | identical |

`enter confirm` is worth calling out separately: the permission dialog truncates
it to `enter con` at 80 columns and prints it in full at 120 and 200. That is
exactly the truncation `OPENCODE_PERMISSION_PATTERN`'s docblock says it refuses
to anchor on, and these files are the evidence that the decision was right —
the three labels it does anchor on (`Allow once  Allow always  Reject`) are
byte-identical at all three widths.

## What the divergences at 200 columns actually are

- **`phrase-in-response.txt`** — `sliceOpenCodeTurn()` + `cleanOpenCodeResponse()`
  extract the empty string at 80 and 120. At 200 they extract
  `8,501 tokens / $0.00 spent / LSP / LSPs are disabled`: the sidebar, saved as
  the assistant's reply. This one is structural — it does not depend on anything
  the user typed.
- **`turn-aborted-after-complete.txt`** — `detectSessionStatus` answers
  `ready` / `opencode_response_complete` at 80 and 120 (the previous turn's
  duration-carrying marker is inside branch D's content window) and
  `running` / `unknown_frame` at 200, because the sidebar's rows push it out.
  The verdict is not "worse" so much as *different at the same instant for the
  same session*, which is what a geometry change must not do.
- **`numbered-answer.txt` / `sidebar-title-phrase.txt`** —
  `OPENCODE_IDLE_COMPOSER_PATTERN` is `^\s*┃\s*Ask anything\.\.\.`, i.e. gutter
  first, then the phrase, nothing else between. At ≥121 columns the sidebar
  prints the SESSION TITLE on a row that already carries a transcript gutter, so
  a title containing the phrase satisfies the anchor. The gutter stops meaning
  "this row belongs to the input box" the moment two panes share a row.

Capture size is the quiet cost: one 200-row frame is ~2.5 KB at 80 columns and
~40 KB at 200, because the sidebar paints a background across the full width of
every row it touches.

## Adding to these

Keep all three widths in step. A frame that exists in `w200/` but not in `w80/`
cannot answer the question the directory exists to answer, and the suite fails if
the three sets are not identical by name.
