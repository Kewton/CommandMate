# Command Code `AskUserQuestion` confirm page, as Auto-Yes met it (Issue #3497)

Kewton/Musunest#283 (2026-10-09, CommandMate 0.44.3): a Command Code worker asked
a free-text question whose answer candidate was the worker's own proposal, on a
page drawn as `❯ 1. Submit` / `2. Cancel`. Auto-Yes answered `1` (Submit) and the
worker implemented the proposal. No capture of that pane was kept, so the two
frames here are the closest reproducible spellings of it.

| file | provenance | what it is for |
|---|---|---|
| `review-page-no-back-hint.txt` | **derived from a live capture**: `../command-code-askuserquestion-2754/review-page-submit-cancel.txt` (Command Code 1.54.1, 200x1000) with exactly one row removed, `← to go back and edit`. Every other byte is as captured | The Review page `readCommandCodeReviewPage` declines only when all three of its rows are drawn. Without the back hint the question reader answers `none`, the generic parser reads `Submit` / `Cancel` as a two-option `multiple_choice` with `Submit` as the default, and Auto-Yes sent `1` |
| `free-text-confirm.ts` (`COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME`) | **synthetic**, written to the shape of the report and to the measured chrome (200-column U+2500 rule, `● … \| ◯ Review` tab strip, `❯` cursor). Plain text, no SGR. A module, not a `.txt`, so the live-capture sweeps over `tests/fixtures/` do not take it in | The question tab is current (not `● Review`), the question body is free text with the worker's own proposal as the answer, and the choices are the numbered `1. Submit` / `2. Cancel` pair |

Both must reach a human: `isCommandCodeQuestionConfirmPage` is true on each and
`detectAndRespondToPrompt` sends no key (`tests/unit/lib/polling/auto-yes-question-confirm-3497.test.ts`).
Nothing here names a real path or repository.
