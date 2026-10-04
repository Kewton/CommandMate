/**
 * Regexes shared by the shape reader and the Command Code block of
 * `selection-shape.ts`. Split out first so the Command Code block can move
 * without a cycle (Issue #3218). Imports nothing: this file is reached from
 * browser-side modules too.
 */

/**
 * A focused search/filter row inside the dialog.
 *
 * Three measured spellings, and nothing wider — this predicate SUPPRESSES a
 * control, so a false positive costs the user their number buttons:
 *  - `Type to search models...` / `type to search` (Command Code 1.40.1);
 *  - `Search models…` (copilot 1.0.80's `/model`, recorded verbatim in
 *    `cli-patterns.ts`'s `COPILOT_SELECTION_FOOTER_PATTERN` docblock);
 *  - `/ search` (copilot's `/session` and `/settings` footers).
 *
 * Deliberately does NOT match claude's `/model` blurb ("Switch between Claude
 * models…") or codex's ("Access legacy models by running codex -m…"), neither of
 * which contains the word.
 */
export const FILTER_INPUT_PATTERN =
  /\btype\s+to\s+search\b|\bsearch\s+\w+\s*(?:…|\.\.\.)|(?:^|·)\s*\/\s+search\b/im;

/**
 * The two footer rows of Command Code's plan review overlay (Issue #2761).
 *
 * Measured on 1.58.0 at 200x1000. The overlay is a rule, a `Plan review: <title>
 * · <path> · v1` header, the plan with a line-number gutter, a second rule, a
 * ` REVIEW ` badge and then, verbatim:
 *
 *     Approve ctrl+a   executes the plan
 *     Cancel esc
 *
 * BOTH rows, adjacent, because each half alone is weak: `Cancel esc` is two
 * words any picker might print, and `Approve` is a word an agent writes in a
 * plan. Multi-line on purpose — it is tested against a joined tail
 * (`NormalizedFrame.lastLines`, or the tail {@link readSelectionListShape}
 * builds), never against a single row.
 *
 * Swept against every fixture in `tests/fixtures` and
 * `tests/unit/lib/detection/fixtures` when this was written (300 files): the
 * only match is the plan review capture itself.
 *
 * ## The `❯` either row may carry (Issue #2793)
 *
 * `↓` past the plan's last line moves the focus onto the ACTION list, and the
 * focused action is drawn with a `❯ ` in front of it and two spaces before its
 * key (`tests/fixtures/command-code-plan-review-2763/`, 1.58.0):
 *
 *     ❯ Approve  ctrl+a   executes the plan        ← `plan-review-action-focus-approve.txt`
 *     Cancel esc
 *
 *     Approve ctrl+a   executes the plan · comments go along as notes
 *     ❯ Cancel  esc                                ← `plan-review-long-scrolled-cancel-focused.txt`
 *
 * Without the optional `❯ ` this pattern missed both frames, and they went on to
 * the composer check, where `COMMAND_CODE_PROMPT_PATTERN` (`^❯(\s*$|\s+\S)`)
 * read the cursor row as the composer and published `ready` / `input_prompt`:
 * `wait` exited 0 on a plan nobody had approved — #2754's `❯`-outside-the-list
 * family. It is also the frame on which `Enter` EXECUTES the focused action, so
 * missing it here would also have left the chat surface's `Enter` on screen
 * (see {@link SelectionListShape.offersPlanApprove}). Only `❯`, and only as a
 * prefix: `❯ ` + the row is the one measured spelling of a focused action.
 * Re-swept over the same two directories with the widened pattern: every match
 * is still a `command-code-plan-review-*` capture, which
 * `command-code-plan-review-2793.test.ts` keeps pinned.
 */
export const COMMAND_CODE_PLAN_REVIEW_FOOTER =
  /^\s*(?:❯ +)?Approve\s+ctrl\+a\b[^\n]*\n\s*(?:❯ +)?Cancel\s+esc\s*$/im;
