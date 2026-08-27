/**
 * opencode's positive dialog detection (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * This is the module Issue #1896 is about, and the shortest one in the tree,
 * because opencode 1.18.21's whole interactive surface was measured and **none
 * of it takes a typed number**:
 *
 * | surface            | rendering                                   | driven by | source |
 * |--------------------|---------------------------------------------|-----------|--------|
 * | permission dialog  | `Allow once   Allow always   Reject` strip  | ←/→ + Enter | #1893 |
 * | `/models`, `/providers`, `/connect`, ctrl+p | fuzzy-search list, no numbers drawn | ↑/↓ + Enter | #1896 |
 *
 * So every dialog this module can report carries `answerMode: 'keys'`, and the
 * Auto-Yes gate therefore never fires for opencode. That is the correct reading,
 * not a degradation: `sendPromptAnswer` types the digit as text for this tool,
 * and Issue #1893 measured what happens next — the `1` is swallowed by the
 * button row and the Enter after it confirms whatever is HIGHLIGHTED, so asking
 * to Reject would have Approved. `wait` still stops for both surfaces
 * (`isSelectionListActive` → exit 10) and the UI still renders NavigationButtons,
 * which send the keys the strip actually takes.
 *
 * ## Why the numbered path is not re-litigated here
 *
 * `buildDetectPromptOptions('opencode')` already declares
 * `hasNumberedDialogs: false`, which stops `detectPrompt` reporting a numbered
 * transcript block as a prompt at all. This module is the second half of the
 * same decision rather than a duplicate of it: the declaration says "there is
 * nothing numbered to find", and this says "and here is what there IS", so the
 * gate can tell an unreadable frame from a dialog it must not answer.
 *
 * ## The gutter, and the one frame where it is missing
 *
 * `OPENCODE_PERMISSION_PATTERN` is anchored on the input box's own `│`/`┃`
 * gutter — that anchor is Issue #1893's, and weakening it here would let the
 * strip's words reach the pane inside a response body and be read as a dialog.
 * The Auto-Yes poller hands this detector a frame whose box drawing has already
 * been removed (`captureAndCleanOutput`), so on THAT path the permission branch
 * cannot match and this module answers `null` instead of `permission`. The gate
 * outcome is identical either way — `null` and `keys` both mean "do not send" —
 * so the anchor is kept at its measured strength rather than being widened for a
 * verdict that would not change.
 */

import {
  OPENCODE_PERMISSION_PATTERN,
  OPENCODE_SELECTION_LIST_PATTERN,
} from '../../cli-patterns';
import { detectOpenCodeModalOverlay } from '../../opencode-modal-overlay';
import type { DialogVerdict, NormalizedFrame } from '../types';

/** What `detect.ts` measured about this frame before handing it over. */
export interface OpenCodeDialogContext {
  /** The content window `detect.ts`'s branch C tests the picker header against. */
  readonly contentWindow: string;
}

/** Splits the button strip into its buttons: two or more spaces separate them. */
const BUTTON_SEPARATOR = /\s{2,}/;

/**
 * Read the buttons out of the row {@link OPENCODE_PERMISSION_PATTERN} matched.
 *
 * The MATCH is sliced, not the row: opencode draws its own key hints
 * (`ctrl+f fullscreen  ⇆ select  enter confirm`) to the right of the strip on
 * the same line, and they are not choices. Using the pattern's own extent keeps
 * this from becoming a second, looser statement of where the strip ends.
 */
function readPermissionButtons(frame: NormalizedFrame): string[] {
  for (const line of frame.lines) {
    const match = OPENCODE_PERMISSION_PATTERN.exec(line);
    if (!match) continue;
    return match[0]
      .replace(/^[^\S\n]*[│┃][^\S\n]*/, '')
      .trim()
      .split(BUTTON_SEPARATOR)
      .map(button => button.trim())
      .filter(button => button !== '');
  }
  return [];
}

/**
 * Does this frame carry an opencode dialog?
 *
 * @param frame - The normalised capture
 * @param context - What `detect.ts` measured; see {@link OpenCodeDialogContext}
 */
export function detectOpenCodeDialog(
  frame: NormalizedFrame,
  context: OpenCodeDialogContext,
): DialogVerdict | null {
  if (OPENCODE_PERMISSION_PATTERN.test(frame.lastLines)) {
    return { kind: 'permission', options: readPermissionButtons(frame), answerMode: 'keys' };
  }

  if (OPENCODE_SELECTION_LIST_PATTERN.test(context.contentWindow)) {
    return { kind: 'picker', options: [], answerMode: 'keys' };
  }

  // Issue #2112: the five dialogs the allowlist above does not name — session
  // list, agent list, timeline, command palette — recognised from the rectangle
  // they are painted as. Reported here as well as in `detect.ts` branch C2 so
  // this seam keeps the promise the branch-C comment makes: the dialog rule
  // reports the dialog the status branch reports.
  //
  // `answerMode: 'keys'`, like every other opencode surface, for the reason the
  // docblock above gives — a typed number is swallowed and the Enter after it
  // confirms whatever is highlighted. `options` is empty because opencode draws
  // no numbers to enumerate.
  //
  // On the Auto-Yes path this cannot match: that caller hands over a frame whose
  // ANSI has already been removed (`captureAndCleanOutput`) and the rectangle IS
  // the SGR. The gate outcome is identical either way — `null` and `keys` both
  // mean "do not send" — which is the same trade the permission branch's gutter
  // anchor makes two paragraphs up.
  if (detectOpenCodeModalOverlay(frame.raw) !== null) {
    return { kind: 'picker', options: [], answerMode: 'keys' };
  }

  return null;
}
