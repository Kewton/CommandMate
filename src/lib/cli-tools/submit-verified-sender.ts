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
 *
 * Issue #1501 hardens the "still pending" branch. A TUI completion popup can
 * REPLACE the typed body with a different command (`/status` -> `/statusline`,
 * `/review` -> `/teamwork-preview`) when Enter selects a highlighted suggestion.
 * The old substring check misread the replacement as "still typed" and resent
 * Enter (executing the wrong command), or as "submitted" and left the residual
 * behind (detonating on the next send). The decision is now three-valued —
 * submitted / pending / replaced — and a `replaced` verdict clears the input
 * line and THROWS instead of resending Enter (see classifySubmit).
 */

import { sendKeys, sendSpecialKeys, capturePane, clearInputLine } from '../tmux/tmux';
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
 * A slash-command sitting on the input line (Issue #1501).
 *
 * TUI completion popups replace a typed slash command with a highlighted menu
 * item (`/status` -> `/statusline`, `/review` -> `/teamwork-preview`); the
 * result is always another slash command. Scoping the "replaced" verdict to
 * `/…` text keeps idle-prompt placeholders that some TUIs paint on an empty
 * composer (gemini's "Type your message or @path", claude's hints, "? for
 * shortcuts") — none of which start with `/` — from being mistaken for a
 * substitution, so a genuinely-submitted message never fails spuriously.
 */
const REPLACEMENT_COMMAND_PATTERN = /^\/[A-Za-z]/;

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

/**
 * Three-valued classification of the read-back pane (Issue #1501).
 *
 *   submitted - the message left the input box (or the tool is generating).
 *   pending   - the message is still verbatim on the input line -> resend Enter.
 *   replaced  - the input line holds DIFFERENT text than we typed (a TUI popup
 *               autocompleted/replaced the command) -> clear the line and throw,
 *               never resend Enter.
 */
export type SubmitState = 'submitted' | 'pending' | 'replaced';

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
 * First non-blank line of the message, trimmed. This is what a TUI shows on the
 * prompt line before the body folds into a paste placeholder. NOT truncated:
 * the replacement check (inputMatchesBody) needs the full first line so that a
 * completion suffix (`/status` -> `/statusline`) is not mistaken for the body.
 */
function firstNonBlankLine(message: string): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? '';
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

/** Input line text with the prompt marker stripped and surrounding space trimmed. */
function stripInputMarker(inputLine: string): string {
  return inputLine.replace(INPUT_LINE_MARKER, '').trim();
}

/**
 * Whether the (marker-stripped, non-empty) input-line text is still our
 * unsent body rather than a TUI-substituted command.
 *
 * The still-unsent body appears verbatim on the input line. Line wrapping can
 * visually truncate it to a PREFIX of the first line, but a completion popup
 * always produces a DIFFERENT string — the body plus a completion suffix
 * (`/status` -> `/statusline`) or an unrelated command (`/review` ->
 * `/teamwork-preview`) — which is never a prefix of the body. So the body is
 * "still there" iff the input text is a prefix of (or equals) the body's first
 * line. This deliberately rejects `/statusline` for a `/status` body: the safe
 * rule is "input text that is not the body (or a prefix of it) is NOT resent".
 */
function inputMatchesBody(strippedInput: string, message: string): boolean {
  const bodyFirstLine = firstNonBlankLine(message);
  if (bodyFirstLine.length === 0) return false;
  return bodyFirstLine.startsWith(strippedInput);
}

/**
 * Classify a captured pane into submitted / pending / replaced (Issue #1501).
 *
 * Version-independent by design — does NOT require the paste placeholder:
 *   A. The tool is generating a response              -> submitted.
 *   B. No input line, or the input line is empty       -> submitted.
 *   C. A paste placeholder is folded on the input line -> pending (Enter eaten).
 *   D. The body is still verbatim on the input line    -> pending (resend Enter).
 *   E. A DIFFERENT slash command is on the input line  -> replaced (TUI popup
 *      autocompleted the command; clear the line and throw, never resend Enter).
 *   F. Any other non-empty text (idle placeholder/hint) -> submitted (unchanged
 *      pre-#1501 permissive default, so normal sends never spuriously fail).
 *
 * C–F are scoped to the input line only, so the user-message echo that a TUI
 * prints into its history above the prompt never causes a false verdict.
 */
export function classifySubmit(
  output: string,
  cliToolId: CLIToolType,
  message: string
): SubmitState {
  const clean = stripAnsi(output);
  const windowLines = clean.split('\n').slice(-VERIFY_WINDOW_LINES);
  const windowStr = windowLines.join('\n');

  // A. Actively generating a response => the message was accepted.
  if (detectThinking(cliToolId, windowStr)) {
    return 'submitted';
  }

  const inputLine = findInputLine(windowLines);
  // B. No input line visible => the prompt scrolled off / moved on => submitted.
  if (!inputLine) {
    return 'submitted';
  }

  const strippedInput = stripInputMarker(inputLine);
  // B. Empty input line => the message left the box => submitted.
  if (strippedInput.length === 0) {
    return 'submitted';
  }

  // C. A paste placeholder is still folded on the input line => body is there.
  if (PASTE_PLACEHOLDER_PATTERN.test(inputLine)) {
    return 'pending';
  }

  // D. The typed body is still sitting on the input line => resend Enter.
  if (inputMatchesBody(strippedInput, message)) {
    return 'pending';
  }

  // E. A different slash command is on the input line => a completion popup
  //    replaced what we typed. (Scoped to `/…` so idle-prompt placeholders that
  //    some TUIs paint on an empty composer are never mistaken for this.)
  if (REPLACEMENT_COMMAND_PATTERN.test(strippedInput)) {
    return 'replaced';
  }

  // F. Non-empty, non-command steady-state text (idle placeholder / hint) =>
  //    submitted, preserving the pre-#1501 permissive default.
  return 'submitted';
}

/**
 * Backward-compatible boolean view of {@link classifySubmit}: submitted vs not.
 * A `replaced` verdict is NOT "submitted", so this returns false for it too.
 */
export function isSubmitted(output: string, cliToolId: CLIToolType, message: string): boolean {
  return classifySubmit(output, cliToolId, message) === 'submitted';
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
    const state = classifySubmit(output, cliToolId, message);

    if (state === 'submitted') {
      invalidateCache(sessionName);
      return;
    }

    if (state === 'replaced') {
      // A TUI completion popup replaced our command with a different one.
      // Resending Enter would EXECUTE that command (Issue #1501 flavor A);
      // leaving it in place lets the residual detonate on the next send
      // (flavor B). Clear the input line (best-effort) and surface the failure
      // to the caller instead of ever resending Enter.
      try {
        await clearInputLine(sessionName);
      } catch (clearError: unknown) {
        logger.error('submit-clear-input-failed', {
          sessionName,
          cliToolId,
          error: clearError instanceof Error ? clearError.message : String(clearError),
        });
      }
      invalidateCache(sessionName);
      logger.error('submit-replaced-by-tui-completion', { sessionName, cliToolId, attempt });
      throw new Error(
        `Message was replaced by a TUI autocompletion for session ${sessionName}; the input no longer matches the sent text. Cleared the input line without submitting to avoid executing a different command.`
      );
    }

    // state === 'pending' — still typed-but-unsent, resend a single Enter and re-check.
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
