/**
 * The live-region parts the two opencode generations share (Issue #3183;
 * design doc §7 "opencode" / "opencode-v2").
 *
 * Both draw the composer as a run of `┃` gutter rows ending in the model bar,
 * then a `╹▀▀…` rule, then a footer carrying `ctrl+p` (or v1's `ctrl+t`). Both
 * REMOVE that footer and rule while an approval strip or a question form is up
 * (`opencode-live-1893/permission-bash.txt`, `opencode-v2-dialogs-2984/
 * permission.txt` / `question.txt` end on a `┃` row), so finding them is
 * finding the composer.
 *
 * The user's own turns are drawn on the same gutter
 * (`opencode-agent-health-3021/quoted-dialog-reply-done.txt` L17-L24 holds a
 * quoted `Allow once   Allow always   Reject` strip inside one), which is why the
 * composer is the gutter run directly above the rule and nothing higher.
 *
 * @module lib/detection/tools/opencode-gutter-live-region
 */

import { lastContentRow } from './live-region';
import type { LiveRegionHit, LiveRegionMarker } from './types';

/** How far above the last row the keybinding footer may sit (v1 1.18.33 wraps it over 3 rows). */
const FOOTER_MAX_ROWS = 4;
/** How far above the footer the `╹▀` rule may sit. */
const RULE_MAX_ROWS = 3;
/** How far above the bottom a dialog's title may sit. */
const DIALOG_MAX_ROWS = 60;

const FOOTER_PATTERN = /ctrl\+[tp]\b/;
const RULE_PATTERN = /^\s*╹▀+/;
const GUTTER_PATTERN = /^\s*[┃│]/;

export const OPENCODE_GUTTER_COMPOSER: LiveRegionMarker = {
  locate({ contentLines }): LiveRegionHit | null {
    const last = lastContentRow(contentLines);
    let footer = -1;
    for (let i = last; i >= Math.max(0, last - FOOTER_MAX_ROWS); i--) {
      if (FOOTER_PATTERN.test(contentLines[i])) {
        footer = i;
        break;
      }
    }
    if (footer < 0) return null;
    let rule = -1;
    for (let i = footer - 1; i >= Math.max(0, footer - RULE_MAX_ROWS); i--) {
      if (RULE_PATTERN.test(contentLines[i])) {
        rule = i;
        break;
      }
    }
    if (rule < 0) return null;
    let start = rule;
    while (start - 1 >= 0 && GUTTER_PATTERN.test(contentLines[start - 1])) start--;
    return { start, end: last, atBottom: true };
  },
};

/** The bottom-most gutter row `title` matches, within the last rows of the pane. */
export function opencodeGutterDialogTop(title: RegExp): LiveRegionMarker {
  return {
    locate({ contentLines }): LiveRegionHit | null {
      const last = lastContentRow(contentLines);
      for (let i = last; i >= Math.max(0, last - DIALOG_MAX_ROWS); i--) {
        if (GUTTER_PATTERN.test(contentLines[i]) && title.test(contentLines[i])) return { start: i };
      }
      return null;
    },
  };
}
