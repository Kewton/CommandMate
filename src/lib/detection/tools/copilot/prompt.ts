/**
 * GitHub Copilot CLI's positive dialog detection (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * ## The one thing that makes copilot safe to read: the bottom row
 *
 * copilot 1.0.80 paints a status bar on the bottom row of the pane and nothing
 * else there — key hints when idle, `● Working … esc interrupt` while it
 * generates. A dialog or a picker takes that row AWAY (its box, or the picker's
 * own footer, occupies the bottom of the pane), which is why
 * `readCopilotStatusBar` answering `null` is the positional guard everything
 * below rests on.
 *
 * It has to be positional, because copilot's own answer text can forge every
 * textual anchor on this frame. Two live captures in the repository prove it:
 * `status-vocabulary-in-response.txt` (copilot printed ` ● Working esc
 * interrupt` as body text) and `picker-vocabulary-in-response.txt` (it printed a
 * picker's footer as body text). On both, the status bar is still drawn, so this
 * module declines them before it looks at a single word — the same argument
 * Issue #1885 made for the status branches and Issue #1895 for the picker one.
 *
 * ## What was measured (copilot-cli 1.0.80, 200x1000 pane)
 *
 * | frame                                       | bottom row      | block          | footer                                                        |
 * |---------------------------------------------|-----------------|----------------|---------------------------------------------------------------|
 * | `copilot-live-1885/permission-dialog.txt`   | box border      | `❯ 1. Yes` ×3  | `↑/↓ to navigate · enter to select · esc to cancel`            |
 * | `copilot-picker-1895/picker-permissions.txt`| picker footer   | `❯ 1. Manual` ×2 | `1-2 to select · ↑/↓ to navigate · enter to confirm · esc to cancel` |
 * | `copilot-picker-1895/picker-theme.txt`      | picker footer   | 5 options      | `↑/↓ to navigate · …`                                          |
 * | `copilot-live-1885/turn-complete.txt`       | **idle bar**    | the agent's own `1. … 4.` essay | prose                                     |
 *
 * The last row is the reason the guard is not optional: copilot's finished reply
 * is a four-item numbered list whose first item carries a `●` bullet, so the
 * block reader finds a "selected option 1" on it. The status bar is what tells
 * the two apart, and it costs one comparison.
 *
 * `1-2 to select` in the picker footer is also a measurement worth keeping: it
 * is copilot stating, in its own UI, that these menus take a typed number.
 */

import {
  COPILOT_SELECTION_FOOTER_PATTERN,
  COPILOT_FOLDER_TRUST_ANCHORS,
  stripBoxDrawing,
  type CopilotStatusBarState,
} from '../../cli-patterns';
import { findNumberedOptionBlock } from '../dialog-block';
import type { DialogVerdict, NormalizedFrame } from '../types';

/** What `detect.ts` measured about this frame before handing it over. */
export interface CopilotDialogContext {
  /** `readCopilotStatusBar(frame.contentLines)`; `null` means a dialog took the row. */
  readonly statusBar: CopilotStatusBarState | null;
  /** `isCopilotSelectionFrame(frame.contentLines)` — Issue #1895's picker rule. */
  readonly selectionFrame: boolean;
  /** Exclusive end of the content region (`frame.contentLines.length`). */
  readonly contentEnd: number;
}

/** copilot's permission question, in the spelling 1.0.80 draws. */
const COPILOT_PERMISSION_QUESTION_PATTERN = /do you want to\b/i;

/** How many non-blank rows above the options may hold the question. */
const QUESTION_SCAN_ROWS = 4;

function readContextAbove(lines: readonly string[], firstRow: number): string {
  const rows: string[] = [];
  for (let i = firstRow - 1; i >= 0 && rows.length < QUESTION_SCAN_ROWS; i--) {
    const row = lines[i].trim();
    if (row === '') continue;
    rows.push(row);
  }
  return rows.join('\n');
}

/**
 * Does this frame carry a copilot dialog?
 *
 * @param frame - The normalised capture
 * @param context - What `detect.ts` measured; see {@link CopilotDialogContext}
 */
export function detectCopilotDialog(
  frame: NormalizedFrame,
  context: CopilotDialogContext,
): DialogVerdict | null {
  // The positional guard. While copilot draws its status bar, whatever else is
  // on the pane is transcript.
  if (context.statusBar !== null) return null;

  const lines = stripBoxDrawing(frame.clean).split('\n');
  const block = findNumberedOptionBlock(lines, context.contentEnd);

  if (block && COPILOT_SELECTION_FOOTER_PATTERN.test(block.footer)) {
    const question = readContextAbove(lines, block.firstRow);
    const isTrust = COPILOT_FOLDER_TRUST_ANCHORS.some(anchor => question.includes(anchor));
    const kind = isTrust
      ? 'trust'
      : COPILOT_PERMISSION_QUESTION_PATTERN.test(question)
        ? 'permission'
        : 'picker';
    return { kind, options: block.options, answerMode: 'numbered' };
  }

  // A picker copilot draws WITHOUT numbers (`/model`, `/agent`, `/skills` …).
  // Reported so the frame is not mistaken for one nobody could read, but with
  // no options and `keys`: nothing here can be answered by sending text, and
  // Issue #1895's probe measured that a string typed at an open picker is not
  // swallowed — it starts a session with that string as the prompt.
  if (context.selectionFrame) {
    return { kind: 'picker', options: [], answerMode: 'keys' };
  }

  return null;
}
