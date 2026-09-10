# claude-idle-numbered-list-2457 — Claude replies that the generic parser reads as prompts

Input for the numbered-list gate of Issue #2457
(`tests/unit/polling/response-checker-numbered-list-gate-2457.test.ts`).

Every frame here is a Claude Code pane whose LAST TURN IS AN ANSWER. None of them
carries a dialog. What they carry is the shape that made the chat surface draw a
tool-approval chip over ordinary prose: a Markdown numbered list under a line
that reads as a question.

## Synthetic, and why that is the right kind of input here

**These frames are composed, not captured.** A live capture would prove that
Claude Code draws this shape — which was never in doubt; the incident report is
the evidence — but it could not be *aimed*. The thing under test is a boundary
between two readings of one pane, and each frame below moves exactly one variable
across it (footer present / footer not yet redrawn, list finished / list still
being written, question-like lead-in / not). A live corpus large enough to hold
all seven of those, differing in one row each, is not something you can capture on
purpose.

The positive side of the boundary is NOT synthesised. Every "a real dialog must
still be saved" assertion in the suite runs on
`tests/unit/lib/detection/fixtures/claude-live-1708/`, which is a live
`tmux capture-pane -p -e` of claude-cli 2.1.240 — permission dialog,
AskUserQuestion confirmation screen (the one with no footer at all), and the idle
pane. Composing a frame that a rule must ACCEPT would be circular; composing one
it must REJECT is just stating the case.

## How the frames are built

Modelled row-for-row on `claude-live-1708/idle-taskpanel.txt` (claude-cli 2.1.240,
200x1000 alternate-screen pane), with these deliberate differences:

| | |
|---|---|
| ANSI | **None.** Every reader on this path runs `stripAnsi` first, and no assertion in the suite is about an SGR attribute. The one place ANSI is load-bearing — the composer's dim ghost suggestion of #1879 — is not exercised here, because these panes have no banner to mistake. |
| Blank filler | **Removed.** A live 1000-row pane puts ~880 blank rows between a short transcript and the footer. `detectPrompt` collapses blank runs (`normalizeTuiFrameForDetection`), `extractResponse` trims trailing blanks, and `normalizeFrame` windows on the last non-blank rows, so the filler changes no verdict — and leaving it out is what makes these files reviewable. |
| Width | 200 columns: the separators are `─` ×200 and the status bar is padded to match, because `findClaudeInputBox` requires `^─{10,}$` rows. |
| Line endings | `\n`, one trailing newline. |
| Chrome | The footer is the live four-row block: the effort chip (`◉ xhigh · /effort`), the opening `─` rule, the composer row, the closing `─` rule, the status bar. `findClaudeChromeStart` cuts from the effort chip down, so anything the transcript must keep sits at least two rows above the opening rule. |

## The frames, and what each is for

`candidate` below is what the shipping generic parser says **before** the gate —
measured, not assumed, and pinned by the suite so none of these can quietly stop
reproducing:

- **frame** = `detectPrompt(stripBoxDrawing(stripAnsi(pane)))`, i.e. what
  `extractResponse`'s prompt sites see;
- **response** = the same call on `extractResponse(...).response`, i.e. what
  `checkForResponse`'s save path sees once the chrome has been cut off.

| File | Turn | frame | response | Why it is here |
|---|---|---|---|---|
| `reply-numbered-list-idle.txt` | finished | no | **multiple_choice** | The incident. Three numbered items under `…どれから着手しますか?`, the completion marker, the footer. Must be saved as an ordinary reply. |
| `reply-numbered-list-taskpanel.txt` | finished | no | **multiple_choice** | The same pane with the task panel drawn above the footer — the overlay #1708 had to teach the parser to skip. |
| `reply-numbered-list-composer-text.txt` | finished | no | **multiple_choice** | The same pane with unsent text already typed into the composer. The reply must still be saved as a reply, and nothing may be typed at that composer. |
| `reply-numbered-list-repaint.txt` | finished | **multiple_choice** | multiple_choice | The same reply captured before the footer was redrawn. With no composer row there is no user-input barrier, so the candidate reaches `extractResponse`'s OWN prompt sites — this is the frame that proves the gate there is load-bearing. |
| `reply-numbered-list-generating-repaint.txt` | **running** | **multiple_choice** | multiple_choice | The same, mid-stream: option 2's label is cut off and the tail is `✻ Churning… (12s · esc to interrupt)`. The early prompt check runs BEFORE the thinking test, so without the gate this frame ends the turn on a half-written list. Must stay `isComplete: false`. |
| `reply-question-paragraph.txt` | finished | no | **multiple_choice** | #1896's shape as claude renders it: the agent asks which provider to use and lists two. The rows are a dialog's; nothing else on the pane is. |
| `reply-quotes-dialog-wording.txt` | finished | no | **multiple_choice** | A reply that quotes Claude's own permission dialog, `Do you want to proceed?` and `Esc to cancel · Tab to amend` included. The stale-footer cut in `normalizeTuiFrameForDetection` handles the frame; the save path's re-read on the chrome-free response does not. |
| `reply-table.txt` | finished | no | no | The control. A Markdown table whose row labels are `1.` / `2.` / `3.`, drawn with the `│` glyph #2247 had to stop treating as banner art. Already refused upstream — kept so the suite says which negatives the gate is responsible for and which it is not. |

Claude's own dialog rules (`detectDialog`) answer `null` for all eight, which is
what the gate reads. The two `claude-live-1708` dialogs answer `permission` and
`ask_user`, which is what keeps the fix from being "stop saving prompts".
