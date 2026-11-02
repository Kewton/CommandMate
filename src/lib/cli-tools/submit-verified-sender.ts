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
 *
 * Issue #1880 closes the hole on the OTHER side of the send. Everything above
 * verifies what happens after Enter; nothing looked at what was already in the
 * composer before the body was typed. `sendKeys` injects the body as plain
 * keystrokes at the TUI's CURRENT CURSOR POSITION, so residual text is spliced
 * into the body instead of being replaced by it. #1878 measured four shapes of
 * that damage: content mutation (`echo PREFILLED` + body), slash-command
 * demotion (a `/cost` body typed after residual is no longer `/`-initial),
 * order inversion when the cursor sat at column 0, and — worst — total loss of
 * the body when the RESIDUAL started with `/` (`/costZZTOP…` is an
 * `Unknown command`, so the message never reaches the model at all). All four
 * reported `exit 0` / `Message sent.` / `sessionStatus: ready`, i.e. they were
 * indistinguishable from a clean send by every signal a caller has. The
 * composer is therefore emptied and read back BEFORE the body is typed — see
 * {@link clearComposerBeforeSend}.
 *
 * Issue #2464 is the body itself going missing on the way in. A body longer
 * than one pty read reaches the TUI as several reads — tmux delivers every byte
 * (12,288 of 12,288 measured on a raw pane), but the reader gets them 1,022
 * bytes at a time on macOS — and Claude Code 2.1.268 reassembles unbracketed
 * input read by read and keeps only the LAST one. A 1 KB brief arrived as its
 * final 2 bytes, a 4 KB one as its final 8, and the send still said `Message
 * sent.`: the tail sits in the composer as ordinary text, Enter submits it, and
 * nothing downstream can tell a tail from a message. Neither the #1880 clear nor
 * the Enter timing is involved — both were switched off in controls and the
 * loss was unchanged. So a long body is now PASTED ({@link pasteBody}: one
 * bracketed paste, which the TUI reads as a unit), and Enter is withheld until
 * the composer shows the whole of it ({@link classifyPasteLanded}). The
 * measurements are in `docs/design/2464-long-body-repro-matrix.md`.
 *
 * Issue #3366 is the Enter arriving before the body on codex. codex 0.160.0
 * holds fast keystrokes back as a "paste burst" and draws them only once the
 * burst is over — measured at 200x1000: 34 characters after ~180 ms, 80 after
 * ~380 ms, 135 after ~630 ms, 539 after ~2.2 s — and an Enter that lands inside
 * the burst becomes a newline in the composer. The old fixed 100 ms wait pressed
 * Enter there, and the read-back 200 ms later still saw the idle placeholder
 * (the body had not been drawn yet), which it read as "the message left the
 * box": `Message sent.`, with the body sitting unsent in the composer. So for
 * codex, Enter now waits until the composer shows the typed body
 * ({@link confirmTypedBodyLanded}); a body that never appears THROWS before
 * Enter, as #2464 does for a paste.
 *
 * Issue #3945 is two sends to one instance at once. A send that withdrew its
 * body, or cleared before typing, erased whatever was in the composer — another
 * send's body included — and a codex placeholder carries only a count, so a
 * late one could not be told from the next send's. A send now runs as the
 * instance's only writer (`lib/session/instance-input-lock`), re-reads the pane
 * once it owns it ({@link recheckComposerBeforeInput}),
 * checks it still owns the composer before every key, watches an `unseen`
 * paste a little longer before giving up, and leaves a mark for a body that
 * may still arrive, which the next send waits out ({@link waitOutCarriedPaste}).
 *
 * Issue #4035 is a claude session's first prompt reported sent when it was
 * not. Keys typed right after the prompt appeared were drawn ~1 s later and
 * their Enter was lost, while the read-back still showed the dim placeholder
 * (rule F). On that first prompt a B or F verdict now waits for claude's own
 * `UserPromptSubmit` ({@link awaitPromptReport}), and a later send that clears
 * a body this one called sent says so ({@link reportSubmittedBodyInComposer}).
 */

import * as childProcess from 'child_process';
import { sendKeys, sendSpecialKeys, capturePane, clearInputLine, exactTarget } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import { resolveComposerSpec } from './composer-spec';
import type { ComposerSpec } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';
import {
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_MESSAGE_PROCESSED_WAIT_MS,
} from '@/config/cli-tool-timing-config';
import { getOrInitGlobal } from '@/lib/global-state';
import { clearComposer, readClearComposer, recheckComposerBeforeInput } from '@/lib/session/composer-clear';
import { readPromptSubmitReceipt, type PromptSubmitExpected } from '@/lib/session/prompt-submit-receipt';
import { PASTE_NOT_STARTED_CODE } from '@/lib/session/send-attempt-types';

// Issue #3945 (review-2): moved next to the clear it feeds, so copilot's own
// keys can take it without the shared sender. Re-exported for its callers here.
export { recheckComposerBeforeInput };
import {
  LATE_PASTE_OBSERVE_MS,
  clearExpiredCarriedPasteMark,
  getCarriedPasteMark,
  leaveCarriedPasteMark,
  noteInputStart,
  noteInputTicket,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';
import { extractComposerText } from '@/lib/detection/composer-text';
import {
  classifyPasteLanded,
  classifySubmitWithRule,
  compactText,
  type PasteLandedState,
} from './submit-composer-read';
import {
  CARRIED_MARK_POLL_MS,
  DEFAULT_PASTE_LANDED_ATTEMPTS,
  DEFAULT_TYPED_BODY_ATTEMPTS,
  DEFAULT_VERIFY_ATTEMPTS,
  LITERAL_SEND_MAX_BYTES,
  PASTE_COMMAND_TIMEOUT_MS,
  PASTE_LANDED_POLL_MS,
  PROMPT_REPORT_WAIT_MS,
  RECHECK_CAPTURE_LINES,
  TYPED_BODY_POLL_MS,
  logger,
  type SubmitVerifiedSendParams,
} from './submit-verified-sender-shared';
import { assertInputOwner, assertStillOwnedAfterEnter, awaitReadyUnderLock } from './submit-verified-sender-lock';
import {
  codexComposerShowsWholeBody,
  composerHoldsText,
  describeComposer,
  visibleTypedBody,
} from './submit-verified-sender-composer';
import {
  awaitPromptReport,
  holdsResendEnter,
  logClearInputFailed,
  pasteFailureMayHaveTyped,
  promptReceiptFor,
  rememberScreenOnlySubmit,
  reportSubmittedBodyInComposer,
  resolveSubmitEnterCount,
  settleAwaitedPromptReport,
  shouldAwaitTypedBody,
} from './submit-verified-sender-report';

// Issue #3963: the composer reads moved to `submit-composer-read`; re-exported
// so every caller and test keeps importing them from here.
export { classifyPasteLanded, classifySubmit, classifySubmitWithRule, isSubmitted } from './submit-composer-read';
export type { PasteLandedState, SubmitRule, SubmitState, SubmitVerdict } from './submit-composer-read';

// Issue #4056: the constants, option types and helpers moved to
// `submit-verified-sender-*.ts`; the public ones are re-exported from here.
export {
  INPUT_READINESS_UNDER_LOCK_WAIT_MS,
  LITERAL_SEND_MAX_BYTES,
  PROMPT_REPORT_POLL_MS,
  PROMPT_REPORT_WAIT_MS,
  PROMPT_UNREPORTED_RESEND_NOTE,
  promptUnreportedResendNote,
} from './submit-verified-sender-shared';
export type { InputReadiness, SubmitVerifiedSendParams } from './submit-verified-sender-shared';

declare global {
  // eslint-disable-next-line no-var
  var __submitPasteBufferSeq: { last: number } | undefined;
}

/**
 * Makes each send's tmux paste buffer name unique within this process — on
 * `globalThis` (Issue #3945 review #11): tmux buffers are server-wide, and a
 * module-local counter restarts at 0 in every bundle `next dev` loads this file
 * into, so two sessions' sends could load into one buffer name (the second
 * `load-buffer` overwriting the first before its `paste-buffer`).
 */
const pasteBufferSeq = getOrInitGlobal('__submitPasteBufferSeq', () => ({ last: 0 }));

/** Run one tmux command, optionally feeding it `input` on stdin. */
function runTmux(args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile('tmux', args, { timeout: PASTE_COMMAND_TIMEOUT_MS }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * Put a body into the pane as ONE bracketed paste (Issue #2464).
 *
 * `load-buffer -` takes the body on stdin, so there is no argv ceiling (20 KB
 * went through where `send-keys` refuses past ~16.3 KB). `paste-buffer -p`
 * wraps it in `ESC[200~ … ESC[201~` when — and only when — the application
 * has asked for bracketed paste; a TUI that has not receives exactly the bytes
 * `send-keys -l` would have typed (both measured byte-for-byte on a raw pane).
 * `-r` keeps LF as LF instead of tmux's default LF→CR, which would be an Enter
 * per line for a TUI that did not ask for brackets. `-d` drops the buffer on
 * success; a failure drops it here, so no body is left behind in the server.
 *
 * Issue #3945 (review-1 #2): ownership is asked again between the two commands,
 * right before `paste-buffer` — the session may have been replaced while
 * `load-buffer` ran. A lost ticket drops the buffer and throws before anything
 * reaches the pane (`input lock lost, nothing was typed`).
 *
 * Issue #4011: a failed `load-buffer` throws with `delivery: 'not-started'`
 * (the field `TmuxSendError` carries) — it runs before `paste-buffer`, so none
 * of the body reached the pane, however it failed (an exit status or a timeout).
 * Issue #4031: worded `Failed to load message into tmux buffer` and coded
 * `PASTE_NOT_STARTED_CODE`, so `classifySendFailure` records it `not-sent`.
 *
 * @throws Error when either tmux command fails, or `ticket` lost the composer
 */
async function pasteBody(
  sessionName: string,
  message: string,
  ticket: InstanceInputTicket,
  cliToolId: CLIToolType
): Promise<void> {
  pasteBufferSeq.last += 1;
  const bufferName = `cm-send-${process.pid}-${pasteBufferSeq.last}`;
  try {
    await runTmux(['load-buffer', '-b', bufferName, '-'], message);
  } catch (error: unknown) {
    await runTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Issue #4031: its own wording and code, apart from `paste-buffer`'s
    // failure below (whose body may be on the pane), so the send is recorded
    // `not-sent` with or without a bound relay.
    throw Object.assign(new Error(`Failed to load message into tmux buffer: ${errorMessage}`), {
      delivery: 'not-started' as const,
      code: PASTE_NOT_STARTED_CODE,
    });
  }
  if (!ticket.isCurrent()) {
    await runTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    assertInputOwner(ticket, cliToolId, 'paste-buffer', false);
  }
  // Issue #3953: the send's stamp, as the typed branch takes it — after
  // `load-buffer` (up to its timeout), right before the body reaches the pane.
  // Issue #3992: a refused input boundary (#3957) stops the send here, with the
  // body loaded but not pasted — the buffer is dropped before the refusal goes up.
  try {
    noteInputStart();
  } catch (error: unknown) {
    await runTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    throw error;
  }
  try {
    await runTmux(['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', exactTarget(sessionName)]);
  } catch (error: unknown) {
    await runTmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to paste message into tmux session: ${errorMessage}`);
  }
}

/** The composer's first row, for an error message a person has to act on. */

/**
 * Take a body that did not arrive intact back out of the composer, best effort.
 *
 * Leaving it would put the fragment in front of the next message. claude and
 * codex go through the verified #1879 loop (a paste can span rows); the rest
 * get the single `C-u` the #1501 path already sends to them.
 *
 * @returns Whether the composer was confirmed empty afterwards (Issue #3945):
 *   false for a `C-u` nothing can read back, a failed clear, and a ticket that
 *   no longer owns the composer (no key is sent then).
 */
async function withdrawUnsentBody(
  sessionName: string,
  cliToolId: CLIToolType,
  composerSpec: ComposerSpec,
  ticket: InstanceInputTicket
): Promise<boolean> {
  // Issue #3945: only this send's own composer is taken back. A ticket that is
  // no longer current means another writer owns the composer now, and what it
  // holds is that writer's.
  if (!ticket.isCurrent()) {
    logger.error('paste-withdraw-skipped-not-owner', { sessionName, cliToolId, generation: ticket.generation });
    return false;
  }
  try {
    if (composerSpec.clearBeforeSend) {
      const result = await clearComposer(sessionName, cliToolId, { beforePass: () => ticket.isCurrent() });
      return result.cleared;
    }
    await clearInputLine(sessionName);
    // One `C-u` into a composer nothing here can read: sent, never confirmed.
    return false;
  } catch (clearError: unknown) {
    logger.error('paste-withdraw-failed', {
      sessionName,
      cliToolId,
      error: clearError instanceof Error ? clearError.message : String(clearError),
    });
    return false;
  }
}

/**
 * Hold off typing while a carried paste mark is fresh (Issue #3945 stage 4).
 *
 * A previous send gave up on a body that may still be drawn. Until the mark
 * expires, nothing of this send is typed: a placeholder of the same count as
 * this body would be taken for it ({@link classifyPasteLanded} cannot tell
 * them apart). What appears meanwhile is taken out at once — it is the previous
 * send's, and this owner is the one left to handle it. A tool whose composer is
 * not readable (no `clearBeforeSend`) only waits.
 *
 * @returns Whether there was a mark to wait out
 */
async function waitOutCarriedPaste(
  sessionName: string,
  cliToolId: CLIToolType,
  composer: ComposerSpec,
  ticket: InstanceInputTicket
): Promise<boolean> {
  const mark = getCarriedPasteMark(sessionName);
  if (mark === null) return false;
  logger.warn('carried-paste-mark-wait', {
    sessionName,
    cliToolId,
    originGeneration: mark.originGeneration,
    generation: ticket.generation,
    remainingMs: mark.expiresAt - Date.now(),
  });
  while (Date.now() < mark.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(CARRIED_MARK_POLL_MS, mark.expiresAt - Date.now())));
    if (!composer.clearBeforeSend) continue;
    assertInputOwner(ticket, cliToolId, 'the carried paste wait', false);
    let frame: string;
    try {
      frame = await capturePane(sessionName, RECHECK_CAPTURE_LINES);
    } catch {
      // The re-check after the wait decides about a pane that cannot be read.
      continue;
    }
    if (readClearComposer(frame, cliToolId).state !== 'content') continue;
    const result = await clearComposer(sessionName, cliToolId, {
      initialCapture: frame,
      beforePass: () => ticket.isCurrent(),
    });
    invalidateCache(sessionName);
    logger.warn('carried-paste-withdrawn', {
      sessionName,
      cliToolId,
      originGeneration: mark.originGeneration,
      cleared: result.cleared,
      discardedText: result.discardedText,
    });
  }
  clearExpiredCarriedPasteMark(ticket);
  return true;
}

/**
 * Wait until the composer shows the whole pasted body; decide whether Enter
 * may be pressed (Issue #2464).
 *
 * `pasting` keeps waiting — this is the "a placeholder is not a stuck body"
 * branch: `[Pasted text #3 +20 lines]` for a 60-line brief is a paste still
 * coming in, and Enter pressed now would submit twenty lines. `landed` returns.
 * Everything else ends in a throw WITHOUT Enter, after taking the body back out:
 *
 *   - `mismatch`, at once — no amount of waiting turns a tail into a message;
 *   - `pasting` that never completes within the attempts;
 *   - `unseen` for a tool whose composer this module has measured
 *     (`clearBeforeSend`: claude, codex). There, a composer that never shows
 *     the body means it did not arrive, and Enter would submit nothing while
 *     the caller printed `Message sent.`.
 *
 * `unseen` on any other tool proceeds, with a warning: those composers are
 * drawn in ways this module has not measured, and refusing on them would turn
 * "cannot see it" into "did not send it" for every long message they get.
 *
 * Issue #3945 (stage 4): an `unseen` on a measured tool is not given up at the
 * end of the 2 s. The composer is watched for {@link LATE_PASTE_OBSERVE_MS}
 * more, still under the input lock — so whatever appears in it is this send's
 * (or a person's typing), never another send's — and a placeholder or body that
 * appears is withdrawn before the throw. A read that throws is a failure like
 * the others: withdrawn, `body-not-landed`. When the body may still arrive —
 * nothing of it was ever seen, it was only partly there, a read failed, or the
 * withdrawal could not be confirmed — a carried mark holds the next send off
 * the composer ({@link leaveCarriedPasteMark}).
 *
 * @throws Error when the body cannot be confirmed in the composer
 */
async function confirmPasteLanded(params: {
  sessionName: string;
  message: string;
  cliToolId: CLIToolType;
  composer: ComposerSpec;
  attempts: number;
  ticket: InstanceInputTicket;
}): Promise<void> {
  const { sessionName, message, cliToolId, composer, attempts, ticket } = params;
  let state: PasteLandedState = 'unseen';
  let output = '';
  let readError: string | null = null;
  /** ms after the 2 s check that something of the body appeared, during the late watch. */
  let lateAfterMs: number | null = null;
  try {
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, PASTE_LANDED_POLL_MS));
      output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
      state = classifyPasteLanded(output, cliToolId, message, composer);
      if (state === 'landed' || state === 'mismatch') break;
    }
    if (state === 'unseen' && composer.clearBeforeSend) {
      const observeAttempts = Math.ceil(LATE_PASTE_OBSERVE_MS / PASTE_LANDED_POLL_MS);
      for (let attempt = 1; attempt <= observeAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, PASTE_LANDED_POLL_MS));
        output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
        state = classifyPasteLanded(output, cliToolId, message, composer);
        if (state !== 'unseen') {
          lateAfterMs = attempt * PASTE_LANDED_POLL_MS;
          break;
        }
      }
    }
  } catch (error: unknown) {
    readError = error instanceof Error ? error.message : String(error);
  }

  if (readError === null && lateAfterMs === null && state === 'landed') return;
  if (readError === null && state === 'unseen' && !composer.clearBeforeSend) {
    logger.warn('paste-landed-unverified', { sessionName, cliToolId, bytes: Buffer.byteLength(message, 'utf8') });
    return;
  }

  const bytes = Buffer.byteLength(message, 'utf8');
  const lineCount = message.split('\n').length;
  const shown = readError === null ? describeComposer(output, cliToolId, composer, message) : 'an unreadable pane';
  const withdrawn = await withdrawUnsentBody(sessionName, cliToolId, composer, ticket);
  invalidateCache(sessionName);
  const mayStillArrive = readError !== null || state === 'unseen' || state === 'pasting' || !withdrawn;
  if (mayStillArrive) leaveCarriedPasteMark(ticket);
  logger.error('paste-not-landed', {
    sessionName,
    cliToolId,
    state,
    bytes,
    lines: lineCount,
    shown,
    lateAfterMs,
    readError,
    withdrawn,
    carried: mayStillArrive,
  });

  const what =
    readError !== null
      ? `the composer could not be read while the paste was checked (${readError})`
      : lateAfterMs !== null
        ? `the paste appeared ${lateAfterMs}ms after the ${attempts * PASTE_LANDED_POLL_MS}ms check and was taken back out (the composer showed ${shown})`
        : state === 'mismatch'
          ? `the composer does not hold the message as sent (it shows ${shown})`
          : state === 'pasting'
            ? `the paste had not finished arriving after ${attempts * PASTE_LANDED_POLL_MS}ms (the composer shows ${shown})`
            : `the message never appeared in the composer (${shown})`;
  throw new Error(
    `Message body did not arrive intact for session ${sessionName}: ${what}; the message is ${bytes} bytes / ${lineCount} lines. ` +
      'Enter was not pressed, so nothing was submitted (Issue #2464).'
  );
}

/**
 * Wait until the composer shows the typed body; only then may Enter be pressed
 * (Issue #3366).
 *
 * codex 0.160.0 keeps fast keystrokes in a "paste burst" and inserts them in
 * one go when the burst ends, which took ~4 ms per character at 200x1000
 * (`tests/fixtures/codex-send-burst-3366/`). Until then the composer shows its
 * dim `Ask Codex to do anything`, and an Enter that lands in the burst becomes a
 * newline under the body. The verdict is therefore "the composer's real (not
 * dim) text is the body", read with `extractComposerText`, and nothing less:
 * a prefix is not enough, because codex can draw the first keystrokes before it
 * decides the rest are a burst.
 *
 * On codex the verdict is the whole composer against the whole body
 * ({@link codexComposerShowsWholeBody}, Issue #3906): the extractor's text is
 * the body's first paragraph at most, so on its own it would let Enter go on a
 * body whose later paragraphs had not been drawn.
 *
 * A body that never appears is taken back out and the send THROWS without
 * Enter — nothing was submitted, so the caller must not print `Message sent.`.
 *
 * @throws Error when the composer does not show the body within the attempts
 */
async function confirmTypedBodyLanded(params: {
  sessionName: string;
  message: string;
  cliToolId: CLIToolType;
  composer: ComposerSpec;
  attempts: number;
  ticket: InstanceInputTicket;
}): Promise<void> {
  const { sessionName, message, cliToolId, composer, attempts, ticket } = params;
  const expected = compactText(visibleTypedBody(message));
  if (expected === '') return;

  let output = '';
  let readError: string | null = null;
  try {
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, TYPED_BODY_POLL_MS));
      output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
      // Issue #3906: on codex the whole composer must show the whole body. The
      // extractor's excerpt stops at the first blank row, so its match is only
      // the first paragraph — a five-paragraph body with one paragraph drawn
      // would pass on it — and it cannot reach a body of more than four blocks.
      if (cliToolId === 'codex') {
        if (codexComposerShowsWholeBody(output, message, composer)) return;
        continue;
      }
      const read = extractComposerText(output, cliToolId);
      if (read.state === 'content' && compactText(read.text) === expected) return;
    }
  } catch (error: unknown) {
    readError = error instanceof Error ? error.message : String(error);
  }

  const bytes = Buffer.byteLength(message, 'utf8');
  const shown = readError === null ? describeComposer(output, cliToolId, composer, message) : 'an unreadable pane';
  // Issue #3945: a body never seen (codex can draw a burst late), a read that
  // threw, or a withdrawal that was not confirmed may still put text in the
  // composer after this throw — the next send waits that out.
  const seen = readError === null && composerHoldsText(output, cliToolId, composer, message);
  const withdrawn = await withdrawUnsentBody(sessionName, cliToolId, composer, ticket);
  invalidateCache(sessionName);
  const mayStillArrive = !seen || !withdrawn;
  if (mayStillArrive) leaveCarriedPasteMark(ticket);
  logger.error('typed-body-not-landed', { sessionName, cliToolId, bytes, attempts, shown, readError, carried: mayStillArrive });
  throw new Error(
    `Message body did not appear in the composer for session ${sessionName} within ` +
      `${attempts * TYPED_BODY_POLL_MS}ms (it shows ${shown}); the message is ${bytes} bytes. ` +
      'Enter was not pressed, so nothing was submitted (Issue #3366).'
  );
}

/**
 * Empty the composer before the body is typed into it (Issue #1880).
 *
 * Delegates the how to {@link clearComposer} (#1879), which already sends
 * `C-e`+`C-u` — the `C-e` is what makes a column-0 cursor clearable — in a
 * read-back-verified loop, so a multi-row residual is not left half-eaten and
 * claude's dim ghost suggestions do not spin it to its cap. This function is the
 * policy layer on top: which tools take part, and which outcomes are failures.
 *
 * Exactly one outcome is a failure: **a participating tool still reporting
 * `content` after the pass cap**. That is a composer this code demonstrably
 * could not empty, so typing into it would splice the body into whatever is
 * there and then report success — the defect #1880 exists to remove. Everything
 * else proceeds:
 *
 *   - `unsupported_tool` — never reached (a tool only enters this path when
 *     its `ComposerSpec.clearBeforeSend` is true),
 *     but it means "this layer cannot read that box", not "the box is dirty".
 *   - `no_composer` — the input box is not on screen (a full-screen dialog, a
 *     pager, a session still starting). Nothing was inspected and nothing was
 *     sent; refusing here would invent a second way for sends to stall, on a
 *     frame that carries no evidence of residual text. On codex this is also the
 *     verdict for every dialog frame, which is what keeps a `C-e`+`C-u` volley
 *     off an approval screen (Issue #1890).
 *   - `empty` / `ghost` — verified clean, with or without passes.
 *
 * A throw from {@link clearComposer} itself is a tmux failure (`capture-pane` or
 * `send-keys` returned non-zero) and is deliberately NOT caught: the very next
 * thing this module does is drive the same tmux binary against the same session,
 * and swallowing it would mean typing into a composer whose contents are
 * unknown while still reporting success.
 *
 * Which tools take part is {@link ComposerSpec.clearBeforeSend} since Issue
 * #1933. The gate is `extractComposerText`'s reach, not a preference: it
 * short-circuits every unmeasured tool to `unsupported_tool`, so for
 * gemini/copilot/opencode/vibe-local/antigravity {@link clearComposer} can never
 * observe an empty box and always returns `cleared: false`. Reading that as "the
 * clear failed" and refusing to send would take every one of those tools offline
 * while claude kept working and the unit tests stayed green — so those tools do
 * not enter the clear path at all: no read-back capture, no `C-e`+`C-u`, no new
 * failure mode. Byte-for-byte the pre-#1880 send. codex joined in #1890, and the
 * fix there was to measure codex's input box, not to relax the gate: adding the
 * next tool means a live 200x1000 capture of its box, its idle placeholder and
 * its dialogs, pinned as fixtures.
 *
 * @throws Error when the composer still holds text after the pass cap.
 */
export async function clearComposerBeforeSend(
  sessionName: string,
  cliToolId: CLIToolType,
  composerSpec: ComposerSpec = resolveComposerSpec(cliToolId),
  options: { initialCapture?: string; ticket?: InstanceInputTicket; target?: PromptSubmitExpected } = {}
): Promise<void> {
  if (!composerSpec.clearBeforeSend) return;

  // Issue #3945: the first read is the re-check's frame, and every pass asks
  // first whether this send still owns the composer.
  const { ticket } = options;
  const result = await clearComposer(sessionName, cliToolId, {
    ...(options.initialCapture !== undefined ? { initialCapture: options.initialCapture } : {}),
    ...(ticket !== undefined ? { beforePass: () => ticket.isCurrent() } : {}),
  });
  if (ticket !== undefined) assertInputOwner(ticket, cliToolId, 'the pre-send clear', false);

  reportSubmittedBodyInComposer(sessionName, cliToolId, result.discardedText, result.state !== 'content', options.target);

  if (result.state === 'content') {
    logger.error('pre-send-composer-clear-failed', {
      sessionName,
      cliToolId,
      passes: result.passes,
      remainingLength: result.remainingText.length,
      remainingText: result.remainingText,
    });
    throw new Error(
      `Composer for session ${sessionName} still holds unsent text after ${result.passes} clear passes; ` +
        'refusing to type the message, which would be concatenated with it (Issue #1880).'
    );
  }

  if (result.passes > 0) {
    // The only record of what was thrown away. `remainingText` is the FINAL
    // read and is empty on this path by definition, which is why clearComposer
    // reports `discardedText` separately.
    logger.warn('pre-send-composer-cleared', {
      sessionName,
      cliToolId,
      passes: result.passes,
      state: result.state,
      discardedLength: result.discardedText.length,
      discardedText: result.discardedText,
    });
  }
}

/**
 * Type a message body and submit it, then verify the submit actually happened.
 *
 * The body and Enter are always separate tmux commands (never batched), so the
 * TUI cannot swallow the Enter inside a bracketed-paste buffer. After the
 * initial submit the pane is read back; each time it is still pending an extra
 * Enter is sent, up to `verifyAttempts` of them, and every Enter — the last one
 * included (Issue #3880) — is read back before a verdict. If submit can never
 * be confirmed the function THROWS — callers must surface that as a failure, never as
 * success (Issues #1469/#1470/#1471).
 *
 * A body longer than {@link LITERAL_SEND_MAX_BYTES} is pasted instead of typed,
 * and Enter waits until the composer shows all of it (Issue #2464); a body that
 * does not arrive intact THROWS before Enter, with nothing submitted.
 *
 * Issue #3945: the whole of it — clear, body, Enter, read-back, withdrawal —
 * runs as the session's only writer ({@link withInstanceInputLock}); before
 * anything is typed the pane is re-read under the lock, on every send
 * ({@link recheckComposerBeforeInput}), and a carried paste mark is waited out
 * ({@link waitOutCarriedPaste}, then the re-check again).
 *
 * @throws Error when the body does not arrive intact, or submit cannot be
 *   confirmed within the bounded attempts; `InstanceInputLockTimeoutError`
 *   when the composer was not free in time (nothing typed).
 */
export async function sendMessageWithSubmitVerification(
  params: SubmitVerifiedSendParams
): Promise<void> {
  await withInstanceInputLock(params.sessionName, (ticket) => {
    // Issue #4065: the body's generation, told to the request before any key
    // (and kept by it if the send throws). The same ticket when this joins the
    // send service's outer lock (claude / codex), so it is told once more,
    // with the same number.
    noteInputTicket(ticket);
    return sendUnderInputLock(params, ticket);
  });
}

async function sendUnderInputLock(params: SubmitVerifiedSendParams, ticket: InstanceInputTicket): Promise<void> {
  const {
    sessionName,
    message,
    cliToolId,
    composer = resolveComposerSpec(cliToolId),
    textInputWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    interEnterWaitMs = TUI_TEXT_INPUT_WAIT_MS,
    verifyAttempts = DEFAULT_VERIFY_ATTEMPTS,
    verifyDelayMs = TUI_MESSAGE_PROCESSED_WAIT_MS,
    pasteLandedAttempts = DEFAULT_PASTE_LANDED_ATTEMPTS,
    awaitTypedBody = false,
    typedBodyAttempts = DEFAULT_TYPED_BODY_ATTEMPTS,
    target,
  } = params;
  const submitEnterCount = resolveSubmitEnterCount(params, composer);

  // -1. Issue #3945 (review-1 #4): every send re-reads the pane once it owns
  //     the composer, whether or not it queued — the prompt guard and the
  //     tool's readiness wait ran before the lock, and a dialog can open in the
  //     waits between them and the first key (claude's settle wait, a queue
  //     behind another writer). A dialog refuses the send at once, before any
  //     carried paste is waited out (a refusal leaves the mark as it is); a
  //     send that did wait one out reads again after the wait. The last read
  //     is the pre-send clear's first: a claude/codex send with no mark reads
  //     no more often than before; any other tool gains this one capture.
  let frame = await recheckComposerBeforeInput(sessionName, cliToolId);
  if (await waitOutCarriedPaste(sessionName, cliToolId, composer, ticket)) {
    frame = await recheckComposerBeforeInput(sessionName, cliToolId);
  }
  // Issue #4040: the tool's readiness, asked again of that same newest frame.
  // A dialog was refused just above (and is, at once, on every re-read); this
  // refuses a pane that went back to loading, or still shows the picker of the
  // send before, after the tool's own wait said "ready".
  frame = await awaitReadyUnderLock(params.readiness, frame, { sessionName, cliToolId, ticket });

  // 0. Empty the composer first (Issue #1880). The body below is typed at the
  //    TUI's current cursor position, so anything already in the box would be
  //    spliced into it. Throws for a claude composer that could not be emptied.
  await clearComposerBeforeSend(sessionName, cliToolId, composer, {
    initialCapture: frame,
    ticket,
    ...(target !== undefined ? { target } : {}),
  });

  if (Buffer.byteLength(message, 'utf8') > LITERAL_SEND_MAX_BYTES) {
    // 1'. A body that would reach the TUI as more than one pty read is pasted
    //     as ONE bracketed paste, and Enter waits until the composer shows all
    //     of it (Issue #2464). Typed, Claude Code would keep only its last read.
    const pastedAt = Date.now();
    assertInputOwner(ticket, cliToolId, 'the paste', false);
    try {
      await pasteBody(sessionName, message, ticket, cliToolId);
    } catch (error: unknown) {
      if (pasteFailureMayHaveTyped(error)) leaveCarriedPasteMark(ticket);
      throw error;
    }
    await confirmPasteLanded({ sessionName, message, cliToolId, composer, attempts: pasteLandedAttempts, ticket });
    // 2'. Keep the tool's own registration delay as a floor.
    const remaining = textInputWaitMs - (Date.now() - pastedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  } else {
    // 1. Type the body only — never send Enter in the same tmux command.
    //
    //    `{ literal: true }` is Issue #1933 受入条件 S9 and it is not decoration.
    //    `tmux send-keys` resolves its argument against the key table first, so
    //    until this flag existed a message body of exactly `Escape` interrupted
    //    the agent (`1b`), `Enter` submitted an empty composer (`0d`) and `C-c`
    //    sent SIGINT — and a body starting with `-` was eaten by getopt and sent
    //    nowhere at all, with `rc 0`. All four measured on tmux 3.5a; the argv is
    //    built in `lib/tmux/key-sequence.ts`, which carries the table.
    const typedAt = Date.now();
    assertInputOwner(ticket, cliToolId, 'the body', false);
    // Issue #3953: the send's stamp is taken here — after the lock, the carried
    // mark, the re-check and the clear, right before the body's first key — so a
    // previous turn that ended during any of them is older than this send.
    noteInputStart();
    try {
      await sendKeys(sessionName, message, false, { literal: true });
    } catch (error: unknown) {
      // Issue #3945 (review-1 #6): a keystroke send that failed may still have
      // put part of the body into the pane (a timed-out `send-keys`, #3880's
      // `indeterminate`), to be drawn after this send has let the composer go.
      // Only a call tmux never started (`TmuxSendError.delivery`) typed nothing.
      if ((error as { delivery?: unknown } | null)?.delivery !== 'not-started') leaveCarriedPasteMark(ticket);
      throw error;
    }

    // 2. Let the TUI register the input before pressing Enter. On codex that
    //    means waiting until the body is drawn (Issue #3366): an Enter pressed
    //    while codex still holds the keystrokes as a paste burst becomes a
    //    newline, and the body stays unsent. The fixed wait stays as a floor.
    if (shouldAwaitTypedBody(awaitTypedBody, cliToolId)) {
      await confirmTypedBodyLanded({ sessionName, message, cliToolId, composer, attempts: typedBodyAttempts, ticket });
    }
    const remaining = textInputWaitMs - (Date.now() - typedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  // 3. Submit as a separate command (double Enter for vibe-local's IME mode).
  //    Issue #4035: the agent's own report of the prompt counts from here.
  const enteredAt = Date.now();
  for (let i = 0; i < Math.max(1, submitEnterCount); i++) {
    assertInputOwner(ticket, cliToolId, 'Enter', true);
    await sendSpecialKeys(sessionName, ['Enter']);
    if (i < submitEnterCount - 1) {
      await new Promise((resolve) => setTimeout(resolve, interEnterWaitMs));
    }
  }

  // 4. Read-back verification: confirm the message left the input box, resend
  //    Enter while it is still pending, and throw if it never submits.
  //
  //    Every Enter is followed by a read (Issue #3880, H-1): `attempts` resends
  //    take `attempts + 1` reads. The loop used to resend on its last pending read
  //    and throw straight after, so a message that only that last Enter submitted
  //    was reported "could not be confirmed" — a sent message as exit 99. The
  //    last read sends nothing: no Enter goes out that is not read back.
  const attempts = Math.max(1, verifyAttempts);
  // Issue #4035: one wait for the agent's report per send, however many reads.
  let promptReportDeadline: number | null = null;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));

    let output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
    // Issue #4048: a frame read after the session was replaced is the new
    // process's, and so would be its hooks — neither says anything about this
    // send, whose Enter went to the old one (indeterminate, not `not-sent`).
    assertStillOwnedAfterEnter(ticket, cliToolId, 'the read-back');
    let { state, rule } = classifySubmitWithRule(output, cliToolId, message, composer);
    const receipt = promptReceiptFor({ state, rule, message, sessionName, cliToolId, enteredAt, target });
    // Issue #4035: every verdict names the rule that gave it, so a send reported
    // `sent` can be traced to what the screen showed.
    logger.info('submit-classified', { sessionName, cliToolId, attempt, state, rule, receipt });

    if (receipt === 'awaited') {
      // Issue #4035: the screen says only that the body is not in the composer,
      // on a session that has not reported a prompt yet. Watch, without Enter,
      // until the agent reports it or the composer shows the body after all.
      promptReportDeadline ??= Date.now() + PROMPT_REPORT_WAIT_MS;
      const watched = await awaitPromptReport({
        sessionName,
        message,
        cliToolId,
        composer,
        enteredAt,
        rule,
        deadline: promptReportDeadline,
        ticket,
        ...(target !== undefined ? { target } : {}),
      });
      ({ state, rule, output } = settleAwaitedPromptReport({ watched, sessionName, cliToolId, attempt, rule, output, target }));
    }

    if (state === 'submitted') {
      rememberScreenOnlySubmit({ sessionName, cliToolId, enteredAt, message, ticket, target });
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
        if (ticket.isCurrent()) {
          await clearInputLine(sessionName);
        } else {
          logger.error('submit-clear-input-skipped-not-owner', { sessionName, cliToolId, generation: ticket.generation });
        }
      } catch (clearError: unknown) {
        logClearInputFailed(sessionName, cliToolId, clearError);
      }
      invalidateCache(sessionName);
      logger.error('submit-replaced-by-tui-completion', { sessionName, cliToolId, attempt });
      throw new Error(
        `Message was replaced by a TUI autocompletion for session ${sessionName}; the input no longer matches the sent text. Cleared the input line without submitting to avoid executing a different command.`
      );
    }

    // state === 'pending' / 'indeterminate' after the final read-back: give up below.
    if (attempt === attempts) break;

    if (holdsResendEnter({ state, output, sessionName, cliToolId, message, composer, attempt })) continue;

    // Issue #4035: the Enter thought lost may only have been late — the agent
    // reporting the prompt now means it went, and another Enter would land on an
    // empty composer, or on a dialog that the prompt just opened.
    // Issue #4048: a report read after the session was replaced (during the
    // wait above, say) may be the new generation's own prompt — this send is
    // then indeterminate, never confirmed by it.
    if (readPromptSubmitReceipt(sessionName, cliToolId, enteredAt, target) === 'received') {
      assertStillOwnedAfterEnter(ticket, cliToolId, 'the prompt report check');
      logger.info('submit-confirmed-by-prompt-hook', { sessionName, cliToolId, attempt, rule });
      invalidateCache(sessionName);
      return;
    }

    // state === 'pending' — still typed-but-unsent, resend a single Enter and re-check.
    logger.warn('submit-not-confirmed:resending-enter', {
      sessionName,
      cliToolId,
      attempt,
    });
    assertInputOwner(ticket, cliToolId, 'a resent Enter', true);
    await sendSpecialKeys(sessionName, ['Enter']);
  }

  invalidateCache(sessionName);
  logger.error('submit-verification-failed', { sessionName, cliToolId, attempts });
  throw new Error(
    `Message submit could not be confirmed for session ${sessionName} after ${attempts} attempts (typed but unsent)`
  );
}
