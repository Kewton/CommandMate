/**
 * The read-back's verdicts after Enter and the agent's own report of the prompt
 * (Issue #4056: split out of `submit-verified-sender.ts`, with the helpers
 * #4057 split out of `sendUnderInputLock`). Reads the pane; sends no key.
 *
 * Imports nothing from `submit-verified-sender.ts`.
 */

import { capturePane } from '../tmux/tmux';
import { invalidateCache } from '../tmux/tmux-capture-cache';
import type { ComposerSpec } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';
import {
  findSubmittedBody,
  getPromptSubmitTarget,
  noteSubmittedBody,
  readPromptSubmitReceipt,
  reportsPrompts,
  type PromptSubmitExpected,
  type PromptSubmitReceipt,
} from '@/lib/session/prompt-submit-receipt';
import { markLastSendDiscarded } from '@/lib/session/send-attempt-state';
import { isInputBoundaryRefusal, type InstanceInputTicket } from '@/lib/session/instance-input-lock';
import { SUPPORTED_COMPOSER_TOOLS } from '@/lib/detection/composer-text';
import { classifySubmitWithRule, type SubmitRule, type SubmitState } from './submit-composer-read';
import {
  PROMPT_REPORT_POLL_MS,
  PROMPT_REPORT_WAIT_MS,
  logger,
  promptUnreportedResendNote,
  type SubmitVerifiedSendParams,
} from './submit-verified-sender-shared';
import { composerShowsForeignPasteToken, needsPromptReport } from './submit-verified-sender-composer';
import { assertStillOwnedAfterEnter } from './submit-verified-sender-lock';

/**
 * Watch a session's first prompt until the agent reports it (Issue #4035).
 *
 * Reads the hook record and the composer every {@link PROMPT_REPORT_POLL_MS}
 * until `deadline`, without pressing anything. The deadline is the send's, not
 * the call's: a send that waits again after a resent Enter gets only what is
 * left of its {@link PROMPT_REPORT_WAIT_MS} (it holds the input lock meanwhile).
 *
 *   - the agent reported the prompt — `received`;
 *   - the screen changes its verdict — generating (A), or the body drawn into
 *     the composer after all (C/D, `pending`: the caller resends Enter, as for
 *     any typed-but-unsent body), or a completion (E) — `screen`, with the frame;
 *   - neither, to the end — `unreported`: nothing says the message left.
 *
 * Issue #4048: the wait asks whether `ticket` still owns the session before
 * every read of the report, after every capture, and so before any verdict it
 * returns. The body and its Enter are already in, so a session replaced
 * meanwhile THROWS as indeterminate ({@link assertStillOwnedAfterEnter}) — the
 * old process may have taken the prompt — and the new session's screen and
 * hooks are never read as this send's.
 *
 * The deadline is followed by one last read of the screen
 * ({@link rereadBeforeUnreported}) before `unreported`.
 */
export async function awaitPromptReport(params: {
  sessionName: string;
  message: string;
  cliToolId: CLIToolType;
  composer: ComposerSpec;
  enteredAt: number;
  rule: SubmitRule;
  deadline: number;
  ticket: InstanceInputTicket;
  target?: PromptSubmitExpected;
}): Promise<
  | { verdict: 'received' }
  | { verdict: 'screen'; state: SubmitState; rule: SubmitRule; output: string }
  | { verdict: 'unreported'; rule: SubmitRule }
> {
  const { sessionName, message, cliToolId, composer, enteredAt, deadline, ticket, target } = params;
  const reported = (): boolean => {
    assertStillOwnedAfterEnter(ticket, cliToolId, 'the prompt report wait');
    return readPromptSubmitReceipt(sessionName, cliToolId, enteredAt, target) === 'received';
  };
  let rule = params.rule;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROMPT_REPORT_POLL_MS));
    if (reported()) return { verdict: 'received' };
    const output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
    assertStillOwnedAfterEnter(ticket, cliToolId, 'the prompt report wait');
    const verdict = classifySubmitWithRule(output, cliToolId, message, composer);
    if (verdict.state !== 'submitted' || verdict.rule === 'A') return { verdict: 'screen', ...verdict, output };
    rule = verdict.rule;
  }
  if (reported()) return { verdict: 'received' };
  const last = await rereadBeforeUnreported({ sessionName, message, cliToolId, composer, ticket });
  if (last !== null) return { verdict: 'screen', state: 'submitted', rule: 'A', output: last };
  // The hook may have come while the screen was read.
  if (reported()) return { verdict: 'received' };
  return { verdict: 'unreported', rule };
}

/**
 * The last look at the screen before a first prompt is called `unreported`
 * (Issue #4048 item 1). Only A — the tool generating — saves the send: it is
 * what a `SessionStart`-only environment (the http `UserPromptSubmit` hook not
 * arriving) shows for a body that did go, right at the deadline. Anything else
 * — B, F, the body still in the composer, a capture that fails — leaves the
 * send unconfirmed, and no Enter is pressed for it. Ownership is asked before
 * and after the capture.
 *
 * A says only that something is being generated, not that it is this body
 * (a person's key, or a generation that started otherwise); that limit is
 * accepted, as for every A verdict.
 *
 * @returns The frame when it shows A, else null
 */
async function rereadBeforeUnreported(params: {
  sessionName: string;
  message: string;
  cliToolId: CLIToolType;
  composer: ComposerSpec;
  ticket: InstanceInputTicket;
}): Promise<string | null> {
  const { sessionName, message, cliToolId, composer, ticket } = params;
  assertStillOwnedAfterEnter(ticket, cliToolId, 'the last read before prompt-unreported');
  let output: string;
  try {
    output = await capturePane(sessionName, { startLine: -composer.verifyCaptureLines });
  } catch (error: unknown) {
    logger.warn('prompt-unreported-reread-failed', {
      sessionName,
      cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    assertStillOwnedAfterEnter(ticket, cliToolId, 'the last read before prompt-unreported');
    return null;
  }
  assertStillOwnedAfterEnter(ticket, cliToolId, 'the last read before prompt-unreported');
  const verdict = classifySubmitWithRule(output, cliToolId, message, composer);
  logger.info('prompt-unreported-reread', { sessionName, cliToolId, state: verdict.state, rule: verdict.rule });
  return verdict.state === 'submitted' && verdict.rule === 'A' ? output : null;
}

/**
 * Say so when the pre-send clear finds the body this session last reported
 * submitted (Issue #4035): that body never reached the agent, and the send that
 * said `sent` for it was wrong. The instance's `lastSend` is turned
 * `indeterminate` (the send now running records its own outcome after it).
 *
 * Issue #4048: only for claude, whose first prompt is hook-checked — on any
 * other tool the warning is all (its `lastSend` is not rewritten) — and only the
 * record of the attempt whose body was found (matched by its digest), so a later
 * send, or one the agent reported, is never demoted. With an explicit `target`,
 * the body is looked up only in the entry both the name and the target name.
 */
export function reportSubmittedBodyInComposer(
  sessionName: string,
  cliToolId: CLIToolType,
  composerText: string,
  cleared: boolean,
  target?: PromptSubmitExpected
): void {
  if (composerText === '') return;
  const expected = target === undefined ? undefined : { ...target, cliToolId };
  const found = findSubmittedBody(sessionName, composerText, expected);
  if (found === null) return;
  const owner = reportsPrompts(cliToolId) ? getPromptSubmitTarget(sessionName, expected) : null;
  if (owner !== null) {
    markLastSendDiscarded(
      { ...owner, instanceId: owner.instanceId ?? owner.cliToolId },
      Date.now(),
      found.messageDigest
    );
  }
  logger.warn('pre-send-found-submitted-body', {
    sessionName,
    cliToolId,
    cleared,
    length: composerText.length,
    lastSendDemoted: owner !== null,
  });
}

/** The read-back's state, rule and frame, as {@link sendUnderInputLock}'s loop holds them (Issue #4057). */
export interface SubmitReadBack {
  state: SubmitState;
  rule: SubmitRule;
  output: string;
}

/** `params.submitEnterCount`, else the composer's (Issue #4057: split out of {@link sendUnderInputLock}). */
export function resolveSubmitEnterCount(params: SubmitVerifiedSendParams, composer: ComposerSpec): number {
  return params.submitEnterCount ?? composer.submitEnterCount;
}

/** Whether a failed paste must leave a carried mark (Issue #4057: split out of {@link sendUnderInputLock}). */
export function pasteFailureMayHaveTyped(error: unknown): boolean {
  // Whether tmux put any of it into the pane is unknown — except after a
  // refused input boundary (Issue #3992) or a failed `load-buffer` (Issue
  // #4011, `not-started`), both before `paste-buffer`: a mark then would
  // only hold the next send off for nothing.
  const notStarted = (error as { delivery?: unknown } | null)?.delivery === 'not-started';
  return !isInputBoundaryRefusal(error) && !notStarted;
}

/** Whether the typed body is waited for before Enter (Issue #4057: split out of {@link sendUnderInputLock}). */
export function shouldAwaitTypedBody(awaitTypedBody: boolean, cliToolId: CLIToolType): boolean {
  return awaitTypedBody && SUPPORTED_COMPOSER_TOOLS.has(cliToolId);
}

/** The receipt a read-back's verdict asks for (Issue #4057: split out of {@link sendUnderInputLock}). */
export function promptReceiptFor(input: {
  state: SubmitState;
  rule: SubmitRule;
  message: string;
  sessionName: string;
  cliToolId: CLIToolType;
  enteredAt: number;
  target?: PromptSubmitExpected;
}): PromptSubmitReceipt {
  const { state, rule, message, sessionName, cliToolId, enteredAt, target } = input;
  return needsPromptReport(state, rule, message)
    ? readPromptSubmitReceipt(sessionName, cliToolId, enteredAt, target)
    : 'not-required';
}

/** What {@link awaitPromptReport} resolved to (Issue #4057). */
export type PromptReportOutcome = Awaited<ReturnType<typeof awaitPromptReport>>;

/**
 * The read-back after an `awaited` receipt, from what {@link awaitPromptReport}
 * resolved to (Issue #4057: split out of {@link sendUnderInputLock}). Synchronous:
 * the wait itself stays in the caller, so the continuation after it is the
 * original one. THROWS when the agent never reported the prompt.
 */
export function settleAwaitedPromptReport(input: {
  watched: PromptReportOutcome;
  sessionName: string;
  cliToolId: CLIToolType;
  attempt: number;
  rule: SubmitRule;
  output: string;
  target?: PromptSubmitExpected;
}): SubmitReadBack {
  const { watched, sessionName, cliToolId, attempt, rule, output, target } = input;
  if (watched.verdict === 'unreported') {
    // Issue #4048: no extra Enter — the last read did not show the body
    // generating, and the body may have gone all the same (only the http
    // hook missing), so the failure says to look before resending.
    invalidateCache(sessionName);
    logger.error('submit-not-confirmed:prompt-unreported', {
      sessionName,
      cliToolId,
      attempt,
      rule: watched.rule,
      waitedMs: PROMPT_REPORT_WAIT_MS,
    });
    throw new Error(
      `Message submit could not be confirmed for session ${sessionName}: the composer did not show the body ` +
        `(rule ${watched.rule}) but the agent did not report the prompt within ${PROMPT_REPORT_WAIT_MS}ms ` +
        `(Issue #4035). ${promptUnreportedResendNote(target, cliToolId)}`
    );
  }
  if (watched.verdict === 'received') {
    logger.info('submit-confirmed-by-prompt-hook', { sessionName, cliToolId, attempt, rule });
    return { state: 'submitted', rule, output };
  }
  const { state, rule: screenRule, output: screenOutput } = watched;
  logger.info('submit-classified', { sessionName, cliToolId, attempt, state, rule: screenRule, receipt: 'awaited' });
  return { state, rule: screenRule, output: screenOutput };
}

/** Remember a body only the screen called submitted (Issue #4057: split out of {@link sendUnderInputLock}). */
export function rememberScreenOnlySubmit(input: {
  sessionName: string;
  cliToolId: CLIToolType;
  enteredAt: number;
  message: string;
  ticket: InstanceInputTicket;
  target?: PromptSubmitExpected;
}): void {
  const { sessionName, cliToolId, enteredAt, message, ticket, target } = input;
  // Issue #4035: only a body the screen alone called submitted is remembered
  // for the next send's clear. One the agent reported did leave, and the same
  // text back in the composer is claude restoring it (Esc), the history (↑),
  // or a person typing it — not a send that never arrived.
  // Issue #4048: noted only while this send still owns the session (the
  // entry under its name is otherwise a newer generation's), and, with an
  // explicit target, only in the entry the target names.
  assertStillOwnedAfterEnter(ticket, cliToolId, 'the submit record');
  if (readPromptSubmitReceipt(sessionName, cliToolId, enteredAt, target) !== 'received') {
    noteSubmittedBody(sessionName, message, target === undefined ? undefined : { ...target, cliToolId });
  }
}

/** Log a failed clear of a replaced input line (Issue #4057: split out of {@link sendUnderInputLock}). */
export function logClearInputFailed(sessionName: string, cliToolId: CLIToolType, clearError: unknown): void {
  logger.error('submit-clear-input-failed', {
    sessionName,
    cliToolId,
    error: clearError instanceof Error ? clearError.message : String(clearError),
  });
}

/**
 * Whether a read-back that is not the last one sends no Enter (Issue #4057:
 * split out of {@link sendUnderInputLock}; the caller goes on to the next read).
 */
export function holdsResendEnter(input: {
  state: SubmitState;
  output: string;
  sessionName: string;
  cliToolId: CLIToolType;
  message: string;
  composer: ComposerSpec;
  attempt: number;
}): boolean {
  const { state, output, sessionName, cliToolId, message, composer, attempt } = input;
  // state === 'indeterminate' (Issue #3906) — no Enter: the composer does not
  // show the body, so another Enter could submit whatever it does show.
  if (state === 'indeterminate') {
    logger.warn('submit-not-confirmed:composer-unreadable', { sessionName, cliToolId, attempt });
    return true;
  }

  // Issue #3945 (review #1): a paste placeholder that does not count this
  // body is not this body. It can only be a paste that arrived after the
  // initial Enter (a carried send's, past its mark), and another Enter would
  // submit it. One that counts exactly this body cannot be told apart: that
  // Enter is the accepted gap (LATE_TOKEN_AFTER_ENTER_SAME_COUNT in the tests).
  if (composerShowsForeignPasteToken(output, cliToolId, message, composer)) {
    logger.warn('submit-not-confirmed:foreign-paste-token', { sessionName, cliToolId, attempt });
    return true;
  }
  return false;
}
