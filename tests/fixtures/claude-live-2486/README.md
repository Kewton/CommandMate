# claude-live-2486 — AskUserQuestion with a tab row and a preview pane

Input for Issue #2486
(`tests/unit/lib/detection/claude-askuserquestion-picker-2486.test.ts`,
`tests/unit/api/prompt-response-askuserquestion-2486.test.ts`,
`tests/unit/canary/canary-askuserquestion-2486.test.ts`).

## Provenance

Every file is a verbatim `tmux capture-pane -p -e -S -1000` of a live
**claude-cli 2.1.268** session (the build in the Issue), at the production
**200x1000** geometry, captured 2026-09-12. The sessions ran on a private tmux
socket (`-L cmate-canary-x2486-*`) with a throwaway HOME, driven through the
canary's own guarded modules (`scripts/canary/tmux-private.ts`,
`isolated-home.ts`, `session.ts`; guard snapshot checked before and after) with
`--permission-mode manual`.

Each session was given an `ask.json` and the prompt *"Read the file ask.json …
Then call the AskUserQuestion tool exactly once, passing the JSON object in that
file verbatim as the tool input"*, so the row above the picker is the previous
tool's summary (`Read 1 file`) — the role the Bash call played on the Issue's
pane. The JSON is the Issue's own `AskUserQuestion` input (Claude transcript,
2026-09-11T11:42:30Z), varied one element at a time:

| shape | input | what it isolates |
|---|---|---|
| (a) `tabs-*` | the Issue's 2 questions with every `preview` removed | the tab row alone |
| (b) `preview-*` | the Issue's first question alone, previews kept | the preview pane alone (a single question draws ` ☐ 権限モード `, no arrows) |
| (c) `tabs-preview-*` | the Issue's input verbatim | the Issue |
| (e) `preview-numbered-*` | one English question whose preview holds `1. / 2. / 3.` and a table | a stress case beyond the Issue |

Nothing was rewritten. No row carries an email address or a home path (the
banner shows `~/work/x2486-*`, inside the throwaway HOME).

## Files

| file | screen |
|---|---|
| `tabs-q1.txt` | (a) question 1: `←  ☐ 権限モード  ☐ Goal/範囲  ✔ Submit  →`, options 1–4 with descriptions |
| `preview-q1.txt` | (b) question 1, cursor on 1: options column + pane `┌─…─┐` … `└─…─┘`, `Notes: press n to add notes`, unnumbered `Chat about this` |
| `preview-q1-cursor-on-2.txt` | (b) after `Down`: cursor on 2, the pane shows option 2's preview |
| `tabs-preview-q1.txt` | (c) question 1 — **the screen the Issue's `respond "1"` was refused on** |
| `tabs-preview-q2.txt` | (c) question 2 after `Enter`: tab row `←  ☒ 権限モード  ☐ Goal/範囲  ✔ Submit  →`, no pane |
| `tabs-preview-review.txt` | (c) `Review your answers` / `Ready to submit your answers?` / `❯ 1. Submit answers` / `2. Cancel` |
| `tabs-preview-answered-idle.txt` | (c) after `Enter` on Submit: Claude's reply lists the answers as `1. … / 2. …`, idle composer |
| `preview-numbered-q1.txt` | (e) cursor on 1, the pane shows `1. Cut a branch / 2. Run the tests / 3. Open the PR` |
| `preview-numbered-q1-cursor-on-2.txt` | (e) cursor on 2, the pane shows `1. Merge / 2. Pray` |

## Where it broke (before the fix)

`detectClaudeDialog` (`src/lib/detection/tools/claude/prompt.ts`) has four ways
to decline a frame; the one that fired is **"no numbered block"**, and only on
frames with a **preview pane**. The tab row by itself declined nothing.

| file | transcript tail | `findNumberedOptionBlock` | `detectClaudeDialog` | `evaluateDialogPresence` | `detectPrompt` |
|---|---|---|---|---|---|
| `tabs-q1` | footer row | options 1–4, `❯` | `dialog` | present | `multiple_choice`, but `question` = `Read 1 file ←  ☐ 権限モード  ☐ Goal/範囲  ✔ Submit  → cmate-…` |
| `preview-q1` | footer row | **null** | **null** | **absent** | `multiple_choice`, labels `整えた状態で続行   ┌──…┐` / `ファイル読取のみで続行   │`, `question` led by `Read 1 file ☐ 権限モード` |
| `tabs-preview-q1` | footer row | **null** | **null** | **absent** | as `preview-q1`, `question` led by `Read 1 file ←  ☐ …  ✔ Submit  →` |
| `tabs-preview-q2` | footer row | options 1–4 | `dialog` | present | `question` led by the tab row |
| `tabs-preview-review` | `2. Cancel` | Submit answers / Cancel | `ask_user` | present | as before |
| `preview-numbered-q1` | footer row | the PANE's `1. / 2. / 3.` (no cursor) | null | absent | not a prompt (`claude_selection_list`) |
| `preview-numbered-q1-cursor-on-2` | footer row | the PANE's `1. Merge / 2. Pray` | null | absent | `multiple_choice` with the pane's `Merge` / `Pray` as the options |
| `tabs-preview-answered-idle` | `✻ Cogitated for 21s` | the reply's `1. / 2.` (no cursor) | null | absent | not a prompt |

Why "no numbered block": the block reader walks up from the transcript tail
through at most eight non-blank footer rows (`DEFAULT_FOOTER_SCAN_ROWS`,
`src/lib/detection/tools/dialog-block.ts`) looking for the last option row. On a
preview screen the rows under the options are the footer, `Chat about this`,
`Notes: press n to add notes`, the pane's bottom border and the pane's
interior — the walk runs out of rows before it reaches `2. ファイル読取のみで続行`.
So `/prompt-response` answered `prompt_no_longer_active` (`vouched: false`, the
Issue's server log) while `wait` — which reads `detectPrompt`, and `detectPrompt`
did see a `multiple_choice` — exited 10.

`stripBoxDrawing` is what made the pane's text reach `question`, `approvalTarget`
and the labels: it removes a leading `│` with the whitespace before it, so a pane
row with nothing in the options column slides to column 0 and reads as
transcript, while the option rows keep the pane's `┌` / `│` in the middle.

## After the fix

Every frame above except the answered one is vouched for, with the options the
picker shows (`整えた状態で続行 (Recommended)` / `ファイル読取のみで続行` on
(b) and (c) — the wrapped `(Recommended)` joined back), and `question` is the
question alone. `answered-idle` stays declined.
