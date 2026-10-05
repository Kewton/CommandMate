import {
  OPENCODE_PANE_WIDTH_ENV,
  OPENCODE_SIDEBAR_MIN_WIDTH,
  resolveOpencodePaneWidth,
} from '@/config/tmux-pane-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/opencode-pane-width');

/**
 * {@link resolveOpencodePaneWidth}, plus the one-line operator feedback the
 * pure config module deliberately cannot emit (Issue #2047).
 *
 * `tmux-pane-config.ts` has no imports at all — that is a documented property
 * (#1906), and pulling the logger in there would make every consumer of a
 * constant depend on the logging stack. So the resolver stays silent and the
 * warning lives here, at the two call sites that actually resize a pane.
 *
 * Two things are worth telling the operator, and neither is an error:
 *
 * - the value was DROPPED (not an integer, or outside the accepted bounds), so
 *   the pane they are about to look at is the 80-column default rather than
 *   what they asked for;
 * - the value was ACCEPTED but lands at or above
 *   {@link OPENCODE_SIDEBAR_MIN_WIDTH}, where opencode 1.18.22 paints its
 *   right-hand sidebar into the same rows as the transcript. #2047 measured
 *   what that does to this repo's own readers — a saved "reply" made entirely
 *   of sidebar chrome, a status flip on an aborted turn, and a false idle
 *   composer off the session title. It is still allowed, because an operator
 *   who only ever reads the pane in the browser may want it; it is not silent.
 *
 * @returns Pane width in columns, ready to hand to `resize-window`.
 */
export function resolveOpencodePaneWidthChecked(
  options: { warnSidebar: boolean }
): number {
  const requested = process.env[OPENCODE_PANE_WIDTH_ENV];
  const width = resolveOpencodePaneWidth();

  if (requested !== undefined && String(width) !== requested.trim()) {
    logger.warn('opencode-pane-width-rejected', {
      requested,
      applied: width,
    });
  } else if (options.warnSidebar && width >= OPENCODE_SIDEBAR_MIN_WIDTH) {
    // v1 only: the width at which opencode-v2 starts painting a sidebar has not
    // been measured, so v2 passes `warnSidebar: false` (Issue #3296).
    logger.warn('opencode-pane-width-sidebar-visible', {
      width,
      sidebarMinWidth: OPENCODE_SIDEBAR_MIN_WIDTH,
    });
  }

  return width;
}
