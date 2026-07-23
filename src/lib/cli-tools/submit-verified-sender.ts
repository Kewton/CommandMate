/**
 * Submit-verified message sender (Issues #1469, #1470, #1471).
 *
 * A single shared helper that replaces the seven near-identical
 * "type body -> press Enter -> maybe recover paste" sequences previously
 * duplicated across session-key-sender.ts and every cli-tools/*.ts sendMessage(),
 * plus the terminal API route's raw `sendKeys(command)` batch send.
 *
 * Why this exists (root cause):
 *   tmux `send-keys <body> C-m` batches the body and Enter into a SINGLE command.
 *   ink/React TUIs (Claude Code, Codex, ...) treat the injected body as a
 *   bracketed paste and swallow the trailing C-m as a newline inside the paste
 *   buffer, so the message is typed but never submitted. The recovery that used
 *   to guard this was gated on `message.includes('\n')` (single-line messages
 *   skipped entirely), keyed off Claude's version-specific `[Pasted text #\d+`
 *   string, and never verified that submit actually happened (fire-and-forget).
 *
 * This helper fixes all three:
 *   1. Body and Enter are ALWAYS sent as separate tmux commands with a delay
 *      between them (never a single body+C-m batch).
 *   2. Recovery + verification apply to EVERY message (no `\n` gate).
 *   3. After submit it reads the pane back and confirms the message actually
 *      left the input box (empty input line) or the tool began generating.
 *      If it is still pending it resends Enter, bounded; if it can never be
 *      confirmed it THROWS (callers must not report success on a stuck send).
 *
 * The verification is intentionally NOT keyed off the version-specific
 * `[Pasted text #\d+` placeholder. That placeholder is used only as one
 * "still pending" positive signal (broadened to be version-resilient); the
 * primary decision is "is the message still sitting on the input line?".
 */

import { sendKeys, sendSpecialKeys, capturePane } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { stripAnsi, detectThinking } from '../detection/cli-patterns';
import type { CLIToolType } from './types';
import {
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_MESSAGE_PROCESSED_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cli-tools/submit-verified-sender');

/**
 * Version-resilient pasted-text placeholder.
 *
 * Broader than PASTED_TEXT_PATTERN (`/\[Pasted text #\d+/`) so it still matches
 * when a CLI version drops the `#N` and renders `[Pasted text +46 lines]`
 * (Issue #1469 condition 2). Used ONLY as a positive "still in the input box"
 * signal — never as the sole submit gate — so applying it to every tool is safe:
 * a tool that never renders it simply never matches.
 */
const PASTE_PLACEHOLDER_PATTERN = /\[Pasted text[\s#]/;

/**
 * Prompt input-line markers across the supported TUIs.
 * claude/gemini/copilot: `>` or `❯`; codex: `›`; antigravity: `>`;
 * vibe-local: `ctx:N% ❯`. Leading whitespace is tolerated (tmux padding).
 */
const INPUT_LINE_MARKER = /^\s*(?:ctx:\d+%\s*)?[>❯›]/;

/** Lines of pane tail to inspect when verifying submit. */
const VERIFY_WINDOW_LINES = 12;

/** Default bounded read-back attempts before giving up (throwing). */
const DEFAULT_VERIFY_ATTEMPTS = 4;

/** Minimum fragment length used to decide the body is still on the input line. */
const MIN_FRAGMENT_LENGTH = 3;
const MAX_FRAGMENT_LENGTH = 24;

export interface SubmitVerifiedSendParams {
  /** tmux session name (already validated by the caller chain). */
  sessionName: string;
  /** Message body to type (sent verbatim, without a trailing newline). */
  message: string;
  /** CLI tool id — selects the tool-specific "generating" detector. */
  cliToolId: CLIToolType;
  /**
   * ms to wait after typing the body before pressing Enter, so the TUI
   * registers the input first. Default: TUI_TEXT_INPUT_WAIT_MS (100).
   */
  textInputWaitMs?: number;
  /**
   * Number of Enter presses for the INITIAL submit. Default 1.
   * vibe-local uses 2 (IME mode: first Enter inserts a newline, the second
   * submits) — see VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS.
   */
  submitEnterCount?: number;
  /** ms between the initial Enter presses when submitEnterCount > 1. */
  interEnterWaitMs?: number;
  /** Bounded read-back attempts. Default DEFAULT_VERIFY_ATTEMPTS (4). */
  verifyAttempts?: number;
  /**
   * ms to wait before each read-back capture. Default
   * TUI_MESSAGE_PROCESSED_WAIT_MS (200). Callers that must stay snappy
   * (terminal route) can lower the attempts/delay to keep the total bounded.
   */
  verifyDelayMs?: number;
}

/**
 * First non-blank fragment of the message, used to decide whether the body is
 * still sitting on the input line. Only the first line matters because that is
 * what a TUI shows on the prompt line before folding into a paste placeholder.
 */
function comparableFragment(message: string): string {
  const firstLine = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '';
  return firstLine.slice(0, MAX_FRAGMENT_LENGTH);
}

/**
 * Locate the active input line within the pane tail: the last line that begins
 * with a prompt marker. Scanned bottom-up so a status-bar/footer line rendered
 * BELOW the input box (antigravity's "? for shortcuts", vibe-local's status bar)
 * does not hide the real input line above it.
 */
function findInputLine(windowLines: string[]): string | null {
  for (let i = windowLines.length - 1; i >= 0; i--) {
    if (INPUT_LINE_MARKER.test(windowLines[i])) {
      return windowLines[i];
    }
  }
  return null;
}

/**
 * Decide whether a captured pane shows the message as submitted.
 *
 * Version-independent by design — does NOT require the paste placeholder:
 *   A. The tool is generating a response          -> submitted.
 *   B. A paste placeholder is on the input line    -> NOT submitted (Enter eaten).
 *   C. The body fragment is still on the input line -> NOT submitted.
 *   D. Otherwise (empty input line / moved to history) -> submitted.
 *
 * B and C are scoped to the input line only, so the user-message echo that a
 * TUI prints into its history above the prompt never causes a false "pending".
 */
export function isSubmitted(output: string, cliToolId: CLIToolType, message: string): boolean {
  const clean = stripAnsi(output);
  const windowLines = clean.split('\n').slice(-VERIFY_WINDOW_LINES);
  const windowStr = windowLines.join('\n');

  // A. Actively generating a response => the message was accepted.
  if (detectThinking(cliToolId, windowStr)) {
    return true;
  }

  const inputLine = findInputLine(windowLines);
  if (inputLine) {
    // B. A paste placeholder is still folded on the input line => not submitted.
    if (PASTE_PLACEHOLDER_PATTERN.test(inputLine)) {
      return false;
    }
    // C. The typed body is still sitting on the input line => not submitted.
    const fragment = comparableFragment(message);
    if (fragment.length >= MIN_FRAGMENT_LENGTH && inputLine.includes(fragment)) {
      return false;
    }
  }

  // D. Input line is clear (or absent) and nothing is generating => submitted.
  return true;
}

/**
 * Type a message body and submit it, then verify the submit actually happened.
 *
 * The body and Enter are always separate tmux commands (never batched), so the
 * TUI cannot swallow the Enter inside a bracketed-paste buffer. After the
 * initial submit the pane is read back up to `verifyAttempts` times; each time
 * it is still pending an extra Enter is sent. If submit can never be confirmed
 * the function THROWS — callers must surface that as a failure, never as
 * success (Issues #1469/#1470/#1471).
 *
 * @throws Error when submit cannot be confirmed within the bounded attempts.
 */
export async function sendMessageWithSubmitVerification(
  params: SubmitVerifiedSendParams
): Promise<void> {
  const {
    sessionName,
    message,
    cliToolId,
    textInputWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    submitEnterCount = 1,
    interEnterWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    verifyAttempts = DEFAULT_VERIFY_ATTEMPTS,
    verifyDelayMs = TUI_MESSAGE_PROCESSED_WAIT_MS,
  } = params;

  // 1. Type the body only — never send Enter in the same tmux command.
  await sendKeys(sessionName, message, false);

  // 2. Let the TUI register the input before pressing Enter.
  await new Promise((resolve) => setTimeout(resolve, textInputWaitMs));

  // 3. Submit as a separate command (double Enter for vibe-local's IME mode).
  for (let i = 0; i < Math.max(1, submitEnterCount); i++) {
    await sendSpecialKeys(sessionName, ['Enter']);
    if (i < submitEnterCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, interEnterWaitMs));
    }
  }

  // 4. Read-back verification: confirm the message left the input box, resend
  //    Enter while it is still pending, and throw if it never submits.
  const attempts = Math.max(1, verifyAttempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));

    const output = await capturePane(sessionName, { startLine: -VERIFY_WINDOW_LINES });
    if (isSubmitted(output, cliToolId, message)) {
      invalidateCache(sessionName);
      return;
    }

    // Still typed-but-unsent — resend a single Enter and re-check.
    logger.warn('submit-not-confirmed:resending-enter', {
      sessionName,
      cliToolId,
      attempt,
    });
    await sendSpecialKeys(sessionName, ['Enter']);
  }

  invalidateCache(sessionName);
  logger.error('submit-verification-failed', { sessionName, cliToolId, attempts });
  throw new Error(
    `Message submit could not be confirmed for session ${sessionName} after ${attempts} attempts (typed but unsent)`
  );
}
