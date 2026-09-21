# Command Code 1.54.1 `AskUserQuestion`, measured (Issue #2754)

Issues #2521 and #2522 taught the detection chain to recognise and read Command
Code's question screen. Both did it from **one reported 1.53.0 capture** plus
synthetic frames written to its shape. This directory is Issue #2754's: the same
screen on **1.54.1**, captured live, one key at a time, with a capture on each
side of every keystroke.

It draws things #2521 recorded as absent:

|  | 1.53.0 (#2521) | 1.54.1 (here) |
|---|---|---|
| tab strip | `● Dispatch \| ◯ Review` | `✔ Party size \| ✔ Rental car \| ● Update scope \| ◯ Review` — an answered tab is `✔` |
| options | `1.` … `N.` | `1. [ ] …` / `3. [✔] …` on a multi-select |
| free text | `4. Type something...` | still numbered, and it carries a checkbox of its own |
| confirm row | none | `Submit` on the last question, `Next` on the others. No number |
| footer | none | `Enter to select \| Arrow keys to navigate \| 1-9 quick select \| n notes \| c chat \| Esc to cancel` — **only when the call has more than one question** |
| review | none | Enter on `Submit` opens a Review page with `1. Submit` / `2. Cancel` |

The shape the Issue was raised for, captured rather than assumed:

```text
────────────────────────────────────────  (200 columns of U+2500)
✔ Party size | ✔ Rental car | ● Update scope | ◯ Review

Which files should I update?

  1. [ ] calc.js
        Update calc.js.
  2. [✔] README.md
        Update README.md.
  3. [ ] docs
        Update the docs directory.
  4. [✔] tests
        Update the tests.
  5. [ ] Type something...
❯ Submit                                   ← U+276F, one space, no number

Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel
```

`❯ Submit` was the open question #2755 could not start without: whether the
cursor is drawn as a glyph, as a background colour, or as a number in the run.
It is `❯`, one space, the bare word, at column 0 — the same shape the synthetic
frames guessed, now measured. The SGR is a single foreground run
(`ESC[38;5;189m❯ SubmitESC[39m`), no background attribute.

## Provenance — read this before adding a fixture here

| | |
|---|---|
| every file in THIS directory | **live capture.** Nothing here is synthetic |
| build | Command Code **1.54.1**, the globally installed `command-code@1.54.1`. Every frame carries the banner row `# Command Code v1.54.1`, and a test asserts it |
| captured | **2026-09-20** |
| geometry | 200x1000 — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`, the production pane |
| capture command | `tmux -L cc1541-probe capture-pane -p -e -S - -N -E -` (ANSI and box drawing intact) |
| tmux | a **dedicated socket**, `tmux -L cc1541-probe`, session `probe`, `-x 200 -y 1000`. The default socket was never written to; its 22 `mcbd-*` sessions were counted before and after and are unchanged. The probe server was removed with `tmux -L cc1541-probe kill-server` |
| cwd | a throwaway two-file git repo created for the probe and thrown away with the session scratchpad. No real repository was opened |
| launch | one line, no YAML folding: `env -i HOME=… PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color LANG=en_US.UTF-8 commandcode` |
| server | none. No CommandMate server, no daemon, nothing but the one tmux pane |
| the one edit | the cwd row (`# <path>`) named the session scratchpad, so that path — and only that path — was replaced with `/private/tmp/cc1541-probe/sample-repo`. Every other byte is as captured, SGR included. `askuserquestion-1541-2754.test.ts` asserts no `/Users/` and no `scratchpad` survives anywhere in the directory |

The question screens were produced by asking the agent to call
`ask_user_question` with a stated set of questions and options ("Party size",
"Update scope", "Cleanup" …). The *content* is therefore invented; the
*rendering and the key semantics* are the tool's.

Nothing here depends on a git-ignored original, a running session, or any
installed Command Code. Do not write a test that does.

## The twenty-six captures

Read with the key table in
[`docs/design/command-code-1541-askuserquestion.md`](../../../docs/design/command-code-1541-askuserquestion.md),
which names the key that produced each one.

### Recognised by the #2521 region reading — the `❯` is on an option row

| file | the one thing it is for |
|---|---|
| `singleselect-initial-unanswered-tabs.txt` | the positive control. A single-select with nothing answered yet is read **in full** on 1.54.1 — except that the new footer is folded into option 4's label by the tail walk |
| `tabs-single-question.txt` | one question: the strip is `● Update scope \| ◯ Review`, **two** cells, and there is **no footer at all**. Settles #2754's open question about a one-cell strip: it does not occur |
| `multiselect-next-row-not-last-question.txt` | the confirm row reads `Next`, not `Submit`, when the question is not the last one |
| `multiselect-cursor-on-option-1-after-nav.txt` | the `❯` back on option 1 after three `↑`. **Byte-identical** to the frame before any arrow key was pressed — and `Space` behaves differently in the two states |
| `multiselect-cursor-on-option-3-nothing-checked.txt` | the `❯` on the last option, no box ticked: the frame `d` was pressed on |
| `multiselect-up-from-option-1-wraps-to-last.txt` | the FIRST `↑` wraps inside the list to the last option. It does **not** jump to `Submit`; the second `↑` from option 1 does |
| `multiselect-enter-toggled-option-1.txt` | one `Enter` on an option row **toggled** it (`❯ 1. [✔] Shallow`) and left the question up. Enter is not a confirm on this screen |

### A `✔` on the strip — read correctly since #2753

Every frame in this table was misread when it was captured: `✔` (U+2714) was in
neither tab-marker family, so one answered question took the whole strip out of
`isCommandCodeQuestionTabRow` and the generic parser answered instead — the seven
checkbox screens as single-select lists whose labels still read `[ ] calc.js`,
which is what a user reported as "cannot pick more than one". **#2753 added
`COMMAND_CODE_TAB_ANSWERED_MARKERS` and closed that.** The `what it is for` column
below is the 1.54.1 rendering, which did not move.

| file | the one thing it is for |
|---|---|
| `singleselect-answered-tabs.txt` | a single-select under one answered tab, footer present. Now read in full, like the same question one tab earlier — and it inherits the same folded footer, on option 3. Before #2753 its payload's `question` had swallowed the transcript rows above the strip |
| `multiselect-initial.txt` | a multi-select under two answered tabs, every box empty. The frame the bug was reported from: its payload used to keep the `[ ] ` prefix on every label |
| `multiselect-two-checked.txt` | after the digits `2` and `4`. Two boxes ticked, the `❯` still on option 1 |
| `multiselect-cursor-on-option-2.txt` | the `❯` on an **already ticked** box. The old payload called it the default, so answering the default would have UNticked it |
| `multiselect-space-untoggled-cursor-row.txt` | one `Space` later: option 2 is `[ ]` again |
| `multiselect-free-text-focused.txt` | the `❯` on `5. [ ] Type something...` |
| `multiselect-free-text-typed.txt` | `docs/api.md` typed there: the box ticks **itself** as the characters arrive, with no Enter |
| `multiselect-free-text-digit-appended.txt` | a `1` sent to that row lands in the text (`docs/api.md1`) and toggles nothing |

### The review page — the second confirm, and where a default still commits

| file | the one thing it is for |
|---|---|
| `review-page-submit-cancel.txt` | Enter on `❯ Submit` opens the Review page — the answers, `❯ 1. Submit` / `  2. Cancel`, and `← to go back and edit`. **Still misread**: the generic parser answers it as a two-option prompt whose default is `Submit`, so answering the default COMMITS the human's ticks instead of choosing something |
| `review-page-unanswered-warning.txt` | the same page reached by the undocumented `d`: `⚠ You have not answered all questions` over a `No answer`. Declined since #2753 (`numbering-unreadable` — the page draws `1.` twice), which is what the other one should do |

### The `❯` has left the list — published as a finished turn

All six read `ready` / `input_prompt` / `hasActivePrompt: false` today. This is
#2521's 偽完了, on captures rather than on a synthesised frame, and #2753 did not
touch it: the tab strip is irrelevant here, the cursor having left the option
list is the whole cause.

| file | the one thing it is for |
|---|---|
| `multiselect-cursor-on-submit.txt` | **the frame this Issue was raised for.** `❯ Submit`, footer present |
| `multiselect-cursor-on-submit-no-footer.txt` | the same row on a one-question screen, where there is no footer either. The worst shape on the tool |
| `multiselect-up-from-option-1-lands-on-submit.txt` | one `↑` from option 1 jumps straight to `Submit`, skipping the free-text row |
| `multiselect-cursor-on-next.txt` | `❯ Next`: the false completion is about the cursor leaving the list, not about the word `Submit` |
| `multiselect-notes-row-open.txt` | `n` opens `❯ notes: Add notes on this design…` between the free-text row and the confirm row |
| `multiselect-submit-row-space-ticked-option-1.txt` | one `Space` with the `❯` on `Submit` ticked **option 1** — a row the cursor is nowhere near |

### The question is genuinely gone

| file | what it is |
|---|---|
| `not-applicable-question-cancelled.txt` | one `Esc` on an option row took the whole tool call down: `└ User declined to answer questions`, fresh composer. `ready` is **correct** here |
| `not-applicable-chat-disposition.txt` | one `c` closed the dialog with the answers given so far: `└ User wants to discuss the questions instead of answering` |
| `not-applicable-cancelled-from-notes-row.txt` | one `Esc` sent with the `notes:` input open took the whole tool call down, not just the notes row. Caught mid-turn, so it reads `running` |

## `COMMAND_CODE_VERIFIED_AGAINST` was NOT advanced — and why

The stamp in `src/lib/detection/tools/verified-against.ts` still reads
`{ version: '1.40.1', capturedAt: '2026-09-03' }`. Its docblock asked for
exactly the probe this Issue ran ("when a live 1.53.x session is probed — the
question screen, the keys it accepts and what one of them advances — bump this
to that exact version"), so the letter of that paragraph would allow 1.54.1.
The measurement is what refuses it. The stamp feeds `getDetectorFreshness`,
whose whole job is to answer "were these rules measured against the build that
is installed"; and what the probe measured is that the rules **do not answer for
1.54.1**. Seventeen of the twenty-six frames were misread when they were
captured. **#2753 then fixed one of the two causes** — it added the `✔` tab
marker, which moved eight of those frames onto the right reading — and nine are
still misread: six published as finished turns, the review page answerable by
accident, and the two frames the reader does read carrying the new footer inside
their last option's label. Writing `1.54.1` there would make the freshness probe
report a measurement that says the opposite of what was measured, which is the
fail-open version of the #2304 precedent rather than an application of it.
(Independently: `npm run check:detector-freshness` compares against the CLI
installed *now*, which is 1.58.0, so the stamp would read STALE at 1.54.1
anyway.) What #2754 did add to that file is a paragraph recording the probe,
what #2753 closed, what is left, and the condition for advancing it: when #2755
re-reads the rules off these frames, stamp the version whose frames the new
rules were read from.

## Deviations, recorded per the Issue's 逸脱時の扱い

- **Command Code auto-updated itself during the probe.** Its first frame carries
  `◼ [update-notice] update available: v1.58.0 (installing in the background — a
  restart applies it)`, and the globally installed package was `1.58.0` by the
  end. No install command was run by the probe. The **process being read stayed
  on 1.54.1** — it was launched from the 1.54.1 bundle and every frame in this
  directory carries `# Command Code v1.54.1`, which a test asserts — so the
  captures are 1.54.1's. A re-probe on this machine will now meet 1.58.0 and is
  a different measurement.
- **`Esc` removed a question mid-probe.** With the `notes:` input open, one `Esc`
  cancelled the whole tool call rather than just the notes row
  (`└ User declined to answer questions`). The same key was measured again from
  a plain option row and did the same thing; it was never sent to a real
  session. Both outcomes are captured here.
- **`n` and `c` were both safe to press** — neither wrote a file nor changed the
  session. `c` does end the dialog, so it is recorded from its own run.
- **#2753 landed mid-Issue.** It closed the `✔` defect these captures had just
  measured, so the "what the chain publishes" expectations were re-measured
  against it in a second commit. No `.txt` in this directory was touched, and
  nothing about what 1.54.1 *draws* changed.

## What reads this directory

| suite | what it pins |
|---|---|
| `tests/unit/detection/tools/command-code/askuserquestion-1541-2754.test.ts` | the directory explicitly: geometry, anonymisation, the build in the banner, and the current verdict for all twenty-six frames |
| `tests/unit/lib/chat/dialog-frame-2326.test.ts` | the repository-wide crop sweep, which grew by the fifteen frames the region reading reads (seven at first, eight more once #2753 landed) |

`tests/unit/detection/tools/command-code/fixtures.test.ts` does **not** read this
directory — it sweeps `command-code-live-2250` and `chat-dialog-card-2254` only,
which is why the file above had to be written.
