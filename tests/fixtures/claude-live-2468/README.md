# claude-live-2468 — the files-edited HUD under the AskUserQuestion confirmation screen

Input for Issue #2468
(`tests/unit/lib/detection/claude-files-edited-hud-2468.test.ts`,
`tests/unit/api/prompt-response-numbered-list-gate-2457.test.ts`).

| file | what it is |
|---|---|
| `askuserquestion-submit-files-edited-panel.txt` | A live `tmux capture-pane -p -e` of a claude-cli **2.1.267** session (1000-row pane), stopped on the AskUserQuestion confirmation screen: `Ready to submit your answers?` / `❯ 1. Submit answers` / `2. Cancel`. That screen draws no footer. The pane's bottom row is the session-diff HUD, right-aligned after ~110 columns of padding: `+28 files edited before this session (show)`. The other HUD spelling, `No changes this session`, appears once mid-transcript in the same capture. |
| `askuserquestion-submit-files-edited-panel.control-no-panel.txt` | The same capture with those two HUD rows replaced by empty rows and nothing else changed — the one variable, isolated. |

## What the pair established

Before #2468, on the live capture:

| reader | live | control |
|---|---|---|
| `findClaudeTranscriptTail` | the HUD row | `2. Cancel` |
| `detectClaudeDialog` | `null` | `{ kind: 'ask_user', … }` |
| `evaluateDialogPresence('claude', 'multiple_choice', raw).present` | `false` | `true` |

so `/prompt-response`, Auto-Yes and `commandmate respond` all refused a dialog
that was open on screen. The fix recognises the HUD row as Claude chrome in
`findClaudeTaskPanelLines`, and after it both frames read the same.

The row is right-aligned: a reader that slices it from the left sees only
blanks, so every reader matches the TRIMMED row.

## Not rewritten

Home paths in the transcript are as captured; no row a detector reads carries
one.
