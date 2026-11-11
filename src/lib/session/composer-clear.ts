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
 * makes it correct in the presence of a CLI's dim placeholder text: `C-u` cannot
 * remove a suggestion that was never in the buffer, and a loop that compared
 * ANSI-stripped strings instead would spin until its cap on every idle session
 * with a hint on screen — claude's rotating suggestion, or codex's
 * `Ask Codex to do anything` (Issue #1890).
 *
 * The capture is taken with {@link capturePane} directly rather than through
 * `captureSessionOutput`, because that path is served by a 5-second TTL cache
 * (`tmux-capture-cache`): read-back verification against a cached frame would be
 * reading the composer as it looked before the key was sent. The cache is
 * invalidated on the way out so the next poll/push does not serve the pre-clear
 * frame back to the browser.
 */

import { capturePane, clearComposerLine, clearComposerPasteToken, readPaneForeground } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import {
  codexDialogBelow,
  extractLiveComposerText,
  findCodexLiveComposerRow,
  readCodexComposerFrom,
  type ComposerTextResult,
  type ComposerTextState,
} from '@/lib/detection/composer-text';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  AGENT_NOT_IN_FOREGROUND_CODE,
  INPUT_RECHECK_FAILED_CODE,
  INPUT_RECHECK_PROMPT_WAITING_CODE,
} from '@/lib/session/send-attempt-types';

const logger = createLogger('composer-clear');

/**
 * Issue #3927: the "a dialog below the composer means no composer" rule moved
 * to `detection/composer-text.ts`, where the browser can read it too. Re-exported
 * for the callers that took it from here.
 */
export { codexDialogBelow, findCodexLiveComposerRow };

/**
 * The composer as this loop reads it.
 *
 * {@link extractLiveComposerText} — the reading the unsent bar is drawn from
 * (Issue #3927) — and for codex one more reading when it finds no
 * composer (Issue #3906): a body of more paragraphs than the extractor's four
 * blocks — the partly arrived paste the sender reads as `pasting` and withdraws
 * through this function — is still a composer holding text. Only `content` is
 * taken from that reading; anything else stays `no_composer`, so a frame this
 * reading cannot vouch for is never reported as emptied.
 *
 * A composer the extractor does find is still not the live one when a dialog
 * option is drawn below it ({@link codexDialogBelow}): that frame is
 * `no_composer`, so no `C-e`+`C-u` goes into the dialog.
 */
export function readClearComposer(capture: string, cliToolId: string): ComposerTextResult {
  const read = extractLiveComposerText(capture, cliToolId);
  if (cliToolId !== 'codex' || read.state !== 'no_composer') return read;
  const rows = capture.split('\n');
  const row = findCodexLiveComposerRow(rows);
  if (row < 0) return read;
  const held = readCodexComposerFrom(rows, row);
  return held.state === 'content' ? held : read;
}

/**
 * A codex composer holding exactly one collapsed paste placeholder and nothing
 * else (Issue #3937) — the one frame a pass sends `C-e`+`BSpace` for instead of
 * `C-e`+`C-u` ({@link clearComposerPasteToken}).
 *
 * Anything more than the bare placeholder keeps the `C-e`+`C-u` pass, because
 * none of it has been measured on a live codex: a placeholder with typed text
 * after it (`C-e`+`BSpace` would eat the last typed character, not the
 * placeholder), two placeholders, and a body quoting the placeholder's wording
 * among other text. A body that is nothing but that wording typed out is not
 * told apart here; one `BSpace` takes its `]`, and from the next read on it is
 * ordinary text again — `C-e`+`C-u` — so the read-back still decides.
 */
const CODEX_PASTE_TOKEN_ONLY = /^\[Pasted Content \d+ chars?\]$/;

/** Whether a pass over this reading should send `C-e`+`BSpace` (Issue #3937). */
export function isCodexPasteTokenOnly(read: ComposerTextResult, cliToolId: string): boolean {
  return cliToolId === 'codex' && read.state === 'content' && CODEX_PASTE_TOKEN_ONLY.test(read.text.trim());
}

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
  /**
   * How many passes were sent — `C-e`+`C-u`, or `C-e`+`BSpace` for a codex
   * paste placeholder (Issue #3937). Zero when it was already empty.
   */
  passes: number;
  /** What the composer looked like on the final read-back. */
  state: ComposerTextState;
  /** Text still sitting in the composer when `cleared` is false; `''` otherwise. */
  remainingText: string;
  /**
   * What the composer held on the FIRST read — the text this call is about to
   * destroy — or `''` when it started out empty.
   *
   * {@link remainingText} cannot serve as that audit record (Issue #1880): it
   * reports the FINAL read, so a *successful* clear always returns `''` and what
   * was thrown away is gone. Callers that empty the composer on the user's
   * behalf rather than at the user's request — the pre-send clear in
   * `cli-tools/submit-verified-sender.ts` — have to be able to log it.
   */
  discardedText: string;
}

export interface ClearComposerOptions {
  /** Injection seam for tests. Defaults to a cache-bypassing {@link capturePane}. */
  capture?: (sessionName: string) => Promise<string>;
  /** Injection seam for tests. Defaults to {@link clearComposerLine}. */
  sendClear?: (sessionName: string) => Promise<void>;
  /**
   * The pass for a codex composer holding only a paste placeholder
   * ({@link isCodexPasteTokenOnly}, Issue #3937). Injection seam for tests.
   * Defaults to {@link clearComposerPasteToken}.
   */
  sendClearPasteToken?: (sessionName: string) => Promise<void>;
  /** Injection seam for tests. Defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Override the pass cap (tests). */
  maxPasses?: number;
  /**
   * A frame the caller has just captured the way this function would (Issue
   * #3945): taken as the first read instead of capturing again. The sender's
   * re-check under the input lock reads the pane once and hands it on.
   */
  initialCapture?: string;
  /**
   * Asked right before each pass's keys (Issue #3945): false stops the loop
   * without sending them — the caller no longer owns the composer
   * (`InstanceInputTicket.isCurrent`). The result is then `cleared: false`.
   */
  beforePass?: () => boolean;
}

const defaultDelay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Empty the composer of a running session and verify the result.
 *
 * @param sessionName - tmux session to act on (must already exist; the caller checks)
 * @param cliToolId - CLI whose composer layout to read. `claude` and `codex` can
 *   be verified today (see {@link extractComposerText}); for anything else the
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
  let result = readClearComposer(options.initialCapture ?? (await capture(sessionName)), cliToolId);

  // Snapshot before the first pass: every later read shows less of it (a pass
  // eats one row), so this is the only moment the full text exists.
  const discardedText = result.state === 'content' ? result.text : '';

  while (result.state === 'content' && passes < maxPasses) {
    if (options.beforePass !== undefined && !options.beforePass()) {
      // Issue #3945: the composer is another writer's now; its text is not ours to erase.
      logger.warn('composer-clear:not-owner', { sessionName, cliToolId, passes });
      break;
    }
    if (isCodexPasteTokenOnly(result, cliToolId)) {
      await (options.sendClearPasteToken ?? clearComposerPasteToken)(sessionName);
    } else {
      await sendClear(sessionName);
    }
    passes++;
    await delay(COMPOSER_CLEAR_REDRAW_DELAY_MS);
    result = readClearComposer(await capture(sessionName), cliToolId);
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

  return { cleared, passes, state: result.state, remainingText: result.text, discardedText };
}

/**
 * Re-read the pane under the input lock, before anything is typed (Issue #3945
 * stage 2).
 *
 * The prompt guard and the tool's readiness wait ran before the lock was taken,
 * and a dialog may have opened since — while this send queued behind another
 * one, or in a wait that follows readiness. Every send makes it (review-1 #4). This
 * read goes to tmux directly (`capturePane`, never the TTL cache), and its frame
 * is one of three things:
 *
 *   - a dialog (`detectSessionStatus().hasActivePrompt`) — refused, `not-sent`
 *     with the prompt guard's reason (`prompt-waiting`);
 *   - unreadable (the capture or the detector threw) — refused, `not-sent`:
 *     typing into a pane nobody could read is the failure this exists for;
 *   - the pane's own shell in the foreground (Issue #4300, `readPaneForeground`
 *     answers `shell`) — refused, `not-sent` (`agent-not-in-foreground`): the
 *     agent exited and whatever is typed would run as a shell command. Read
 *     before the dialog check, since an exited agent's last frame can still
 *     show one. A foreground that cannot be read is NOT refused here;
 *   - anything else — returned, for the pre-send clear to take as its first read.
 *
 * Also taken by copilot's selection-list keys right before they are typed
 * (review-2), with the same refusals.
 *
 * The scraper's reading only: the structured (hooks) layer is the prompt
 * guard's, consulted before the lock.
 *
 * @throws Error worded for `classifySendFailure` (`prompt-waiting` / `recheck-failed`), with
 *   `code` {@link INPUT_RECHECK_PROMPT_WAITING_CODE} / {@link INPUT_RECHECK_FAILED_CODE} (Issue #3952),
 *   or with `code` {@link AGENT_NOT_IN_FOREGROUND_CODE} (Issue #4300)
 */
export async function recheckComposerBeforeInput(sessionName: string, cliToolId: CLIToolType): Promise<string> {
  let frame: string;
  let dialog: boolean;
  try {
    frame = await capturePane(sessionName, CLEAR_READBACK_CAPTURE_LINES);
    dialog = detectSessionStatus(frame, cliToolId).hasActivePrompt;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('input-recheck-failed', { sessionName, cliToolId, error: message });
    throw Object.assign(
      new Error(`Could not re-read session ${sessionName} before typing (${message}); nothing was typed (Issue #3945).`),
      { code: INPUT_RECHECK_FAILED_CODE }
    );
  }
  await assertAgentInForeground(sessionName, cliToolId);
  if (dialog) {
    logger.warn('input-recheck-prompt-waiting', { sessionName, cliToolId });
    throw Object.assign(
      new Error(
        `A prompt dialog is open in session ${sessionName} ` +
          '(re-checked under the input lock); nothing was typed (Issue #3945).'
      ),
      { code: INPUT_RECHECK_PROMPT_WAITING_CODE }
    );
  }
  return frame;
}

/**
 * Refuse, before any key, when the pane's own shell holds its terminal
 * (Issue #4300): the agent has exited, and a body typed now would be run by the
 * shell as a command. Every tool's send passes here under the input lock
 * ({@link recheckComposerBeforeInput}), so the rule is one place, not one per
 * driver.
 *
 * Only certain evidence refuses (`readPaneForeground` answers `shell`: tmux
 * names a shell AND that shell's process group owns the terminal). A
 * foreground that cannot be read (`unknown`, or the reader itself failing)
 * goes on as before — this change does not make sends less available.
 *
 * @throws Error with `code` {@link AGENT_NOT_IN_FOREGROUND_CODE}
 */
export async function assertAgentInForeground(sessionName: string, cliToolId: CLIToolType): Promise<void> {
  let foreground: string;
  try {
    foreground = await readPaneForeground(sessionName);
  } catch {
    // A reader that failed is no evidence (and a test's tmux mock may not have it).
    return;
  }
  if (foreground !== 'shell') return;
  logger.warn('input-recheck-agent-not-in-foreground', { sessionName, cliToolId });
  throw Object.assign(
    new Error(
      `The agent in session ${sessionName} is not running: the pane is back at its shell, ` +
        'so nothing was typed (Issue #4300). To recover, stop the instance\'s session ' +
        '(`commandmate instances <worktree-id> kill <instance-id>`) and send again: the next send starts a new session.'
    ),
    { code: AGENT_NOT_IN_FOREGROUND_CODE }
  );
}
