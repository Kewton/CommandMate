# Command Code `AskUserQuestion`, read as a prompt (Issue #2522)

Issue #2521 taught the detection chain to **recognise** Command Code's
footer-less question screen and publish a manual-operation fallback for it. This
directory is Issue #2522's: the same screen **read** into a `multiple_choice`
prompt that `respond`, the answer buttons, the prompt-history rows and Auto-Yes
all act on.

The screen, and the row that made it unreadable:

```text
────────────────────────────────────────  (200 columns of U+2500)
● Dispatch | ◯ Review

Approve proceeding from the plan into worktree creation and dispatch?

❯ 1. Prepare worktrees + dispatch (Recommended)
     I create the worktrees and pause for you to
 answer).                                  ← ONE leading space
  2. Worktrees only, then pause
     I create the worktrees and stop for inspection.
  3. Stop at the plan
     No worktrees, no workers.
  4. Type something...                     ← a TextInput, not a fourth choice
```

## Provenance — read this before adding a fixture here

| | |
|---|---|
| every file in THIS directory | **synthetic.** Written by hand for one condition each; no capture, live or anonymised, was used |
| the reported screen | lives in [`../command-code-askuserquestion-2521/`](../command-code-askuserquestion-2521/README.md), whose rows 410–423 are verbatim from a capture reported as **Command Code 1.53.0**, taken **2026-09-12** at the production **200x1000** (`tmux capture-pane -p -e -S - -N -E -`) |
| what the tests read | both directories. Every positive assertion about the REPORTED frame is anchored on #2521's derived capture; the files here cover the shapes around it |

The rows here are written to the same shape as that capture — the same rule
width, the same tab strip, the same one-space continuation — but they are
**not** measurements. Nothing in this directory may be cited as evidence that
Command Code draws a particular screen, and in particular
`COMMAND_CODE_VERIFIED_AGAINST` was **not** advanced on the strength of it: no
live 1.53.x session was probed for this Issue, so the stamp still records the
build the rules were read off (see `src/lib/detection/tools/verified-against.ts`).

Nothing here depends on a git-ignored original, a running `musubi`, or any
installed Command Code. Do not write a test that does.

## The three readings, and which files produce them

`readCommandCodeQuestionDialog` (`src/lib/detection/tools/command-code/dialog.ts`)
answers one of three things, and the file names say which one each frame is for.

### `question-*` — read in full → `PROMPT_DETECTED`

| file | the one thing it is for |
|---|---|
| `question-flat-short.txt` | **no wrapping at all.** The generic parser succeeds on this one — and drags the tab strip and the transcript row above it into the question. It is why the reader runs BEFORE the generic pass, not as its fallback |
| `question-flat-short-ansi-crlf.txt` | the same rows with per-row SGR, CRLF line endings and the pane's padding. Must read to a byte-identical payload |
| `question-description-on-last-option.txt` | the description sits under the LAST option, where `findNumberedOptionBlock` files it as `footer` |
| `question-description-indent-0-1-2.txt` | descriptions at indent 0, 1 and 2, with and without a full stop. All three fold into the option ABOVE them |
| `question-japanese-fullwidth.txt` | a Japanese question ending in `？`, with the tool's own English `Type something...` row and a Japanese description folded into it |
| `question-wrapped-no-question-mark.txt` | a question wrapped over three rows with no `?` anywhere. `?` is usable evidence and deliberately not required |
| `question-taller-than-detection-windows.txt` | a 40-row dialog on a 900-row-padded pane: past the 15-row `lastLines` window and the 40-row selection-shape tail, inside the reader's own 60-row cap |
| `question-default-on-free-text.txt` | the `❯` rests on `Type something...`. Auto-Yes must send nothing and `respond --default` must refuse |

### `unsupported-*` — the screen is up and unreadable → #2521's fallback

`waiting` / `command_code_selection_list` / `hasActivePrompt: false`. No
`promptData`, no auto-answer, and **not** the generic parser's partial list.

| file | why it declines |
|---|---|
| `unsupported-missing-number.txt` | `1. / 2. / 4.` — a gap |
| `unsupported-duplicate-number.txt` | `2.` drawn twice |
| `unsupported-region-too-tall.txt` | a 68-row dialog, past `COMMAND_CODE_QUESTION_MAX_REGION_ROWS` (60) |
| `unsupported-last-option-tail-too-long.txt` | 15 description rows under the bottom option, past the tail allowance, so the option run cannot be reached at all |
| `unsupported-multi-select-checkboxes.txt` | `[ ]` / `[x]` rows. A digit TOGGLES a box here and the confirm is a separate row, so a single-select payload would report an answer that ticked something and stopped |

### `not-applicable-*` — not this screen → every existing verdict stands

| file | what it is |
|---|---|
| `not-applicable-numbered-answer.txt` | an assistant answering in a numbered list, under the same rule. No tab strip |
| `not-applicable-review-tab.txt` | the Review tab has the screen: a diff, whose `1 +` gutter rows are not option rows |
| `not-applicable-answered-then-composer.txt` | the question was answered and a fresh composer is painted under it. The LAST qualifying rule is the composer's, so the region is its hint row |

## Contrasts that are NOT duplicated here

`/model`, `/usage` and the four permission dialogs already have committed
captures, and the suites sweep those directories rather than copying frames:

- `tests/fixtures/command-code-live-2250/` — `dialog-*`, `boot-idle-*`,
  `turn-done-*`, `turn-thinking-*`, `idle-after-interrupt-*`;
- `tests/fixtures/chat-dialog-card-2254/` — `command-code-model-1-40-1.txt` and
  the three 1.47.1 picker states.

## What reads this directory

| suite | what it pins |
|---|---|
| `tests/unit/lib/detection/command-code-askuserquestion-2522.test.ts` | the reader: the three states, the shapes, and the controls |
| `tests/unit/lib/detection/command-code-dialog-producers-2522.test.ts` | status / response poller / extractor / route / Auto-Yes reading ONE frame alike, each through its own pre-processing |
| `tests/unit/lib/auto-yes-poller-command-code-2522.test.ts` | the capture → reader → policy → keystroke wiring, and every case that must send nothing |
| `tests/unit/api/prompt-response-command-code-2522.test.ts` | `respond`: the digit alone, the two refusals, zero keys on either |
| `tests/unit/lib/detection/command-code-askuserquestion-2521.test.ts` | #2521's region reading, and the fallback re-pinned on the `unsupported-*` frames |
| `tests/unit/lib/current-output-builder-2369.test.ts`, `tests/unit/cli/commands/wait.test.ts`, `tests/unit/lib/chat/dialog-frame-2326.test.ts`, `tests/unit/components/worktree/ChatSurface-askuserquestion-2522.test.tsx` | the wire payload, `wait`'s exit 10, the crop sweep, and the one-card rule |
| `tests/integration/command-code-askuserquestion-2522.test.ts` | one capture in, every surface out |
