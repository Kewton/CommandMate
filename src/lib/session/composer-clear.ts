/**
 * Clear the CLI composer, and prove it (Issue #1879).
 *
 * The UI's [Clear] button promises one thing — "the input box is now empty" — so
 * this is a verified operation, not a fire-and-forget key send. #1878 §5-1
 * measured the two ways a single `C-u` silently fails:
 *
 *  1. **Cursor at column 0.** `C-u` kills the text *before* the cursor, so a
 *     composer whose owner pressed Home before walking away survives it intact.
 *     {@link clearComposerLine} fixes that by sending `C-e` first.
 *  2. **Multi-row composer.** `C-u` clears the current row only. A two-row
 *     residual needed three `C-e`+`C-u` passes before the box was actually
 *     empty (`2N-1` for N rows).
 *
 * So the loop here is: read the frame → decide whether real text is still there
 * → send one pass → read again. It stops the moment
 * {@link extractComposerText} stops reporting `content`, which is also what
 * makes it correct in the presence of Claude's dim ghost text: `C-u` cannot
 * remove a suggestion that was never in the buffer, and a loop that compared
 * ANSI-stripped strings instead would spin until its cap on every idle claude
 * session with a hint on screen.
 *
 * The capture is taken with {@link capturePane} directly rather than through
 * `captureSessionOutput`, because that path is served by a 5-second TTL cache
 * (`tmux-capture-cache`): read-back verification against a cached frame would be
 * reading the composer as it looked before the key was sent. The cache is
 * invalidated on the way out so the next poll/push does not serve the pre-clear
 * frame back to the browser.
 */

import { capturePane, clearComposerLine } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { extractComposerText, type ComposerTextState } from '@/lib/detection/composer-text';
import { createLogger } from '@/lib/logger';

const logger = createLogger('composer-clear');

/**
 * Upper bound on `C-e`+`C-u` passes.
 *
 * #1878 measured `2N-1` passes for an N-row composer, so this covers a composer
 * of ~6 rows. The cap exists because the loop's exit condition depends on the
 * TUI redrawing: a CLI that ignores the keys entirely must fail fast and report
 * `cleared: false` rather than hold the request open.
 */
export const MAX_COMPOSER_CLEAR_PASSES = 12;

/** Rows of pane to capture for read-back. The composer is pinned to the bottom. */
const CLEAR_READBACK_CAPTURE_LINES = 200;

/** Grace given to the TUI to repaint after a pass, before reading the frame back. */
export const COMPOSER_CLEAR_REDRAW_DELAY_MS = 120;

export interface ClearComposerResult {
  /**
   * True only when a readable frame positively showed no real text left. False
   * for a CLI whose composer this layer cannot read and for a frame with no
   * input box on screen — see the note where it is computed.
   */
  cleared: boolean;
  /** How many `C-e`+`C-u` passes were sent. Zero when it was already empty. */
  passes: number;
  /** What the composer looked like on the final read-back. */
  state: ComposerTextState;
  /** Text still sitting in the composer when `cleared` is false; `''` otherwise. */
  remainingText: string;
}

export interface ClearComposerOptions {
  /** Injection seam for tests. Defaults to a cache-bypassing {@link capturePane}. */
  capture?: (sessionName: string) => Promise<string>;
  /** Injection seam for tests. Defaults to {@link clearComposerLine}. */
  sendClear?: (sessionName: string) => Promise<void>;
  /** Injection seam for tests. Defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Override the pass cap (tests). */
  maxPasses?: number;
}

const defaultDelay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Empty the composer of a running session and verify the result.
 *
 * @param sessionName - tmux session to act on (must already exist; the caller checks)
 * @param cliToolId - CLI whose composer layout to read. Only `claude` can be
 *   verified today (see {@link extractComposerText}); for anything else the
 *   extractor reports `unsupported_tool`, no pass is sent, and `cleared` is
 *   false — a truthful "this endpoint cannot do that yet" rather than blind keys
 *   into an input line nobody has measured.
 */
export async function clearComposer(
  sessionName: string,
  cliToolId: string,
  options: ClearComposerOptions = {},
): Promise<ClearComposerResult> {
  const capture = options.capture ?? ((name: string) => capturePane(name, CLEAR_READBACK_CAPTURE_LINES));
  const sendClear = options.sendClear ?? clearComposerLine;
  const delay = options.delay ?? defaultDelay;
  const maxPasses = options.maxPasses ?? MAX_COMPOSER_CLEAR_PASSES;

  let passes = 0;
  let result = extractComposerText(await capture(sessionName), cliToolId);

  while (result.state === 'content' && passes < maxPasses) {
    await sendClear(sessionName);
    passes++;
    await delay(COMPOSER_CLEAR_REDRAW_DELAY_MS);
    result = extractComposerText(await capture(sessionName), cliToolId);
  }

  // Whatever happened above, the cached frame is now stale: the poller and the
  // WebSocket push both read through `captureSessionOutput`, and serving the
  // pre-clear frame would leave the bar on screen after the text is gone.
  if (passes > 0) invalidateCache(sessionName);

  // Positive confirmation only. `unsupported_tool` (nothing here can read that
  // CLI's box) and `no_composer` (the box is not on screen, so the buffer behind
  // whatever overlay is up was never inspected) are both "not verified", and
  // reporting them as success would let the UI claim it emptied something it
  // never looked at. Callers get `state` to tell the two apart.
  const cleared = result.state === 'empty' || result.state === 'ghost';
  if (!cleared) {
    logger.warn('composer-clear:not-cleared', { sessionName, cliToolId, passes, state: result.state });
  }

  return { cleared, passes, state: result.state, remainingText: result.text };
}
