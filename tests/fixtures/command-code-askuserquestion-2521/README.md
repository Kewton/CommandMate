# Command Code `AskUserQuestion`, wrapped description (Issue #2521)

Command Code's `AskUserQuestion` screen draws **no hint-bar footer**. It draws a
200-column rule, a tab strip, the question and a numbered list — and when an
option's description wraps, the continuation row begins with a **single space**:

```text
────────────────────────────────────────  (200 columns of U+2500)
● Dispatch | ◯ Review

Approve proceeding from the plan into worktree creation and dispatch?

❯ 1. Prepare worktrees + dispatch (Recommended)
     I create the worktrees and pause for you to
 answer).
  2. Worktrees only, then pause
     I create the worktrees and stop for inspection.
  3. Stop at the plan
     No worktrees, no workers.
  4. Type something...
```

Before Issue #2521 nothing read it. The shared multiple-choice parser ends its
scan at ` answer).`, one row short of option 1, so the frame fell through to the
generic composer check — `COMMAND_CODE_PROMPT_PATTERN` is `^❯(\s*$|\s+\S)`, and
`❯ 1. Prepare worktrees …` matches it. The pane was published as
`ready` / `input_prompt` / `hasActivePrompt:false`, the chat surface raised no
card at all, and `commandmate wait` read the screen as a finished turn and
exited 0 on an agent that was asking a human a question.

## Provenance

| | |
|---|---|
| reported build | Command Code **1.53.0** (as reported by the session; not re-probed) |
| captured | **2026-09-12** |
| geometry | 200x1000 — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`, the production pane |
| capture command | `tmux capture-pane -p -e -S - -N -E -` (ANSI intact) |
| original (git-ignored) | `workspace/temp/fixtures/command-code-askuserquestion-wrapped-live-1530.txt` |

The original capture is **not** in the repository and nothing here depends on
it: both files below are committed, and every test reads them in place. Do not
write a test that needs the original, a running `musubi` session, or any live
Command Code install.

## The two files, and which is which

### `askuserquestion-wrapped-1530-200x1000.txt` — derived from the live capture

1000 rows, ANSI intact, the dialog's rule row at **line 410** and its last
content row at **line 423** — the same positions the original had.

What was kept, and what was replaced:

| rows | what | provenance |
|---|---|---|
| 1–409 | banner, header comments, turns, tool blocks, a TODOS row, a ` ── Processing…` row | **synthesised.** The original's 409 rows of transcript were project-specific; these are written to the same shape (same row kinds, same SGR families) with invented content |
| 410–423 | the rule row and the whole dialog | **verbatim from the live capture**, byte for byte, SGR included. This is what reproduces the defect: the 199-column wrap of option 1's description and the one-space ` answer).` continuation |
| 424–1000 | blank padding | as captured |

The dialog rows were kept rather than rewritten because the wrap column, the
single leading space and the per-row SGR runs **are** the fixture: a re-typed
version would stop reproducing the bug. They contain only CommandMate's own
option vocabulary (`--allow-questions`, `--worker-method`, a worktree count and
a wave list), no private project content, no paths and no identifiers.

### `askuserquestion-wrapped-minimal.txt` — synthetic

24 rows, **no ANSI**. The Issue's minimal example, with a 200-column rule and a
three-row transcript above it. Written by hand, not derived from any capture. It
exists so a reader can see the shape the reading recognises without an ANSI
dump, and so the tests have a case where the dialog is not sitting in a sea of
padding.

## What reads these files

| suite | what it pins |
|---|---|
| `tests/unit/lib/detection/command-code-askuserquestion-2521.test.ts` | the region reading, the status verdict, and ~15 one-condition-off negatives |
| `tests/unit/lib/chat/dialog-frame-2521.test.ts` | the card's rows, from both sides of the cut |
| `tests/unit/lib/chat/dialog-frame-2326.test.ts` | the all-fixtures sweep: these two are the ONLY new frames the Command Code cropper touches |
| `tests/unit/lib/current-output-builder-2369.test.ts` | `isSelectionListActive:true` with `isPromptWaiting:false` / `promptData:null` |
| `tests/unit/cli/commands/wait.test.ts` | `wait` exits 10 with `type: 'selection_list'`, `options: []` |
| `tests/unit/components/worktree/ChatSurface-askuserquestion-2521.test.tsx` | the PC and phone card, its controls, and the absent number row |

## Out of scope here

`promptData`, `respond`, Auto-Yes and `COMMAND_CODE_VERIFIED_AGAINST` are
**Issue #2522**, which reuses this directory and the region reading unchanged.
Nothing in #2521 produces an answerable payload for this screen, and the card
deliberately draws no number keys for it: the trailing `Type something...` is a
separate text input in the TUI, and what a digit does on this screen has not
been measured on a live 1.53.0.
