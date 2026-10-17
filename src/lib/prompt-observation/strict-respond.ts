/**
 * The strict `respond` (Issue #3756, #3746 A-1 / A-4 / A-5): answer a screen
 * only when it is still the screen the caller observed.
 *
 * ## Order
 *
 * Everything that can refuse runs before the first key, against a FRESH
 * capture: the kind, the folder of a trust screen, the option the answer names,
 * the screen open at the bottom of the pane (`./strict-choice`), the launch's
 * owed Enter (`cli-tools/antigravity-startup-trust`), and last the observation
 * token, which is consumed there — before any key, so a send that then fails
 * has still used it up (fail closed). A refusal sends nothing: exit 40.
 *
 * The keys go one at a time. After each ↑/↓ the screen is read again, and the
 * next key goes only while it is the same appearance of the same screen, of
 * the same session generation, with the highlight where the keys put it. Once
 * a key has been sent, every failure is exit 41: keys reached the pane and the
 * caller must not send them again.
 *
 * After the Enter the screen is read for a few seconds to say what it did
 * (`StrictRespondOutcome`); only `advanced` and `next-prompt` are success. A
 * screen that stayed is never answered again from here.
 *
 * ## Serialised, and deduplicated
 *
 * Strict answers to one session run one at a time. A request whose operation
 * id was already used is answered with the stored result and sends nothing;
 * one whose first request is still running is exit 41.
 *
 * ## What it cannot rule out
 *
 * tmux and a human at the pane are not part of any lock: a key typed at the
 * pane, or a screen that changes between the last read and a key, is a residual
 * race. Every read narrows it to the time one key takes; none closes it.
 *
 * The I/O is injected (`StrictRespondDeps`), so the order above is pinned by
 * unit tests.
 *
 * @module lib/prompt-observation/strict-respond
 */

import { getOrInitGlobal } from '@/lib/global-state';
import { isDecisionKind, isStrictRespondKind, type PromptObservationKind } from './kinds';
import { observationBindingOf } from './observe';
import { consumeObservationToken, type ObservationTokenBinding } from './token';
import { isScreenOpenAtBottom, resolveStrictChoice, sameApprovalTarget, strictAnswerKeys } from './strict-choice';
import type {
  PromptObservation,
  StrictRespondOutcome,
  StrictRespondReason,
  StrictRespondResult,
} from './types';

/** How long the highlight may take to arrive after one ↑/↓. */
export const STRICT_HIGHLIGHT_WAIT_MS = 1_500;

/** How long the screen is read after the Enter to say what it did. */
export const STRICT_OUTCOME_WAIT_MS = 3_000;

/** Between two reads of either wait. */
export const STRICT_READ_INTERVAL_MS = 200;

/** A trust screen is refused this long after the launch's owed Enter was claimed. */
export const STRICT_STARTUP_CLAIM_QUIET_MS = 10_000;

/** How long an operation id is remembered. */
export const STRICT_OPERATION_TTL_MS = 10 * 60_000;

const MAX_REMEMBERED_OPERATIONS = 1024;

/** What one fresh read of the pane gave. */
export type StrictScreenRead =
  | { ok: true; observation: PromptObservation; frame: string }
  /** `capture`: the pane could not be read. `observation`: prompt-observation threw on it. */
  | { ok: false; stage: 'capture' | 'observation'; error: string };

export interface StrictRespondDeps {
  /** One fresh capture, observed. Never throws. */
  read(): Promise<StrictScreenRead>;
  sendKey(key: 'Up' | 'Down' | 'Enter'): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** The launch's owed trust Enter for this session (`cli-tools/antigravity-startup-trust`). */
  startup: {
    isWindowOpen(): boolean;
    claimedWithin(ms: number): boolean;
    /** Keep the owed Enter from being claimed until the returned release is called. */
    hold(): () => void;
    /** Drop the owed Enter: this answer was it. */
    discardDebt(): void;
  };
}

export interface StrictRespondRequest {
  worktreeId: string;
  /** tmux session name: the unit answers are serialised on. */
  sessionName: string;
  expectScreen: PromptObservationKind;
  observationToken: string;
  /** An option label, or a position on a numbered screen. */
  answer: string;
  expectTarget: string | null;
  operationId: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __strictRespondSessionTails: Map<string, Promise<void>> | undefined;
  // eslint-disable-next-line no-var
  var __strictRespondOperations: Map<string, { at: number; result: StrictRespondResult | null }> | undefined;
}

const sessionTails = getOrInitGlobal('__strictRespondSessionTails', () => new Map<string, Promise<void>>());
const operations = getOrInitGlobal(
  '__strictRespondOperations',
  () => new Map<string, { at: number; result: StrictRespondResult | null }>()
);

const MESSAGES: Record<StrictRespondReason, string> = {
  session_not_running: 'The instance has no running session.',
  capture_failed: 'The pane could not be read, so the screen could not be checked.',
  observation_failed: 'The screen could not be observed.',
  kind_mismatch: 'The screen on the pane is not the kind the answer was meant for.',
  unsupported_screen: 'The strict respond does not answer this kind of screen.',
  no_token_on_screen: 'The screen carries no observation token.',
  approval_target_unreadable: 'The trust screen is up, but its folder could not be read.',
  expect_target_required: 'A trust screen is answered only with --expect-target <folder>; observedTarget is what it shows.',
  target_mismatch: 'The trust screen names another folder than --expect-target.',
  label_not_found: 'No option on the screen has that label.',
  label_ambiguous: 'More than one option on the screen matches that label.',
  number_on_unnumbered_screen: 'This screen numbers no option: answer with its label.',
  number_out_of_range: 'The screen offers no option with that number.',
  selection_unreadable: 'The highlighted option could not be read.',
  screen_not_open: 'The screen is not the open one at the bottom of the pane (quoted, or under a composer).',
  startup_window_open: "The launch is still confirming agy's trust screen itself.",
  startup_trust_in_flight: "The launch's own Enter for the trust screen was sent moments ago.",
  token_malformed: 'The observation token is not one this server issues.',
  token_expired: 'The observation token has expired: observe the screen again.',
  token_not_yet_valid: 'The observation token is dated in the future.',
  token_mismatch: 'The screen is not the one the observation token was issued on (moved, reopened, or relaunched).',
  token_consumed: 'This appearance of the screen was already answered with a token.',
  token_consumed_store_full: 'Too many screens were answered recently to record one more.',
  send_failed: 'A key could not be delivered; some may have reached the pane.',
  screen_moved_mid_send: 'The screen changed between two keys; the rest were not sent.',
  highlight_not_reached: 'The highlight did not reach the option; the Enter was not sent.',
  outcome_unchanged: 'The Enter was sent and the same screen is still up.',
  outcome_indeterminate: 'The Enter was sent and what the screen did could not be read.',
  operation_in_progress: 'A request with this operation id is still running.',
  strict_endpoint_missing: 'The server has no strict respond endpoint.',
  session_conflict: 'The session belongs to another server.',
  response_unknown: "The server's answer was lost.",
};

/** The parts of one strict answer every result carries. */
interface Facts {
  request: StrictRespondRequest;
  observedKind: PromptObservationKind | null;
  observedTarget: string | null;
  answer: { position: number; label: string } | null;
  keysSent: number;
}

function resultOf(
  facts: Facts,
  code: StrictRespondResult['code'],
  reason: StrictRespondReason | null,
  outcome: StrictRespondOutcome | null = null
): StrictRespondResult {
  const { request } = facts;
  const delivery =
    code === 40 ? 'not-sent' : outcome === null && facts.keysSent > 0 ? 'partial' : facts.keysSent > 0 ? 'sent' : 'indeterminate';
  return {
    strictRespond: 1,
    code,
    delivery,
    reason,
    message: reason === null ? `Answered: the screen ${outcome}.` : MESSAGES[reason],
    expectedKind: request.expectScreen,
    observedKind: facts.observedKind,
    expectedTarget: request.expectTarget,
    observedTarget: facts.observedTarget,
    operationId: request.operationId,
    answer: facts.answer,
    keysSent: facts.keysSent,
    outcome,
    replayed: false,
  };
}

/** The appearance of a screen with the highlight left out: what must not move between two keys. */
function sameAppearance(a: ObservationTokenBinding, b: ObservationTokenBinding | null): boolean {
  if (b === null) return false;
  return (
    JSON.stringify({ ...a, selectedPosition: null, options: [...a.options] }) ===
    JSON.stringify({ ...b, selectedPosition: null, options: [...b.options] })
  );
}

/** Read until the highlight is on `position` (1-based), or say why not. */
async function awaitHighlight(
  deps: StrictRespondDeps,
  binding: ObservationTokenBinding,
  position: number
): Promise<StrictRespondReason | null> {
  const deadline = deps.now() + STRICT_HIGHLIGHT_WAIT_MS;
  for (;;) {
    await deps.sleep(STRICT_READ_INTERVAL_MS);
    const read = await deps.read();
    if (read.ok) {
      const seen = observationBindingOf(read.observation);
      if (!sameAppearance(binding, seen) || !isScreenOpenAtBottom(read.frame)) return 'screen_moved_mid_send';
      if (seen?.selectedPosition === position) return null;
    }
    if (deps.now() >= deadline) return 'highlight_not_reached';
  }
}

function outcomeOf(read: StrictScreenRead, binding: ObservationTokenBinding): StrictRespondOutcome {
  if (!read.ok) return 'indeterminate';
  const { observation } = read;
  if (observation.status === 'unavailable' || observation.screen === null) return 'advanced';
  const kind = observation.screen.kind;
  if (!isDecisionKind(kind)) return 'advanced';
  if (sameAppearance(binding, observationBindingOf(observation))) return 'unchanged';
  if (kind === 'unknown') return 'indeterminate';
  return 'next-prompt';
}

/** Read for a few seconds after the Enter; the first `advanced` / `next-prompt` ends it. */
async function awaitOutcome(deps: StrictRespondDeps, binding: ObservationTokenBinding): Promise<StrictRespondOutcome> {
  const deadline = deps.now() + STRICT_OUTCOME_WAIT_MS;
  let outcome: StrictRespondOutcome = 'indeterminate';
  for (;;) {
    await deps.sleep(STRICT_READ_INTERVAL_MS);
    outcome = outcomeOf(await deps.read(), binding);
    if (outcome === 'advanced' || outcome === 'next-prompt') return outcome;
    if (deps.now() >= deadline) return outcome;
  }
}

/**
 * Every check that runs before a key. Returns the refusal, or what the keys
 * are sent against.
 */
async function checkBeforeSending(
  request: StrictRespondRequest,
  deps: StrictRespondDeps,
  facts: Facts
): Promise<
  | { refused: StrictRespondReason }
  | { binding: ObservationTokenBinding; selectedIndex: number; targetIndex: number }
> {
  const read = await deps.read();
  if (!read.ok) return { refused: read.stage === 'capture' ? 'capture_failed' : 'observation_failed' };
  const { observation, frame } = read;
  const screen = observation.screen;
  if (observation.status === 'unavailable' || screen === null) return { refused: 'session_not_running' };
  facts.observedKind = screen.kind;
  facts.observedTarget = screen.approvalTarget;

  if (screen.kind !== request.expectScreen) return { refused: 'kind_mismatch' };
  if (!isStrictRespondKind(screen.kind)) return { refused: 'unsupported_screen' };
  if (screen.kind === 'antigravity-trust') {
    if (screen.approvalTarget === null) return { refused: 'approval_target_unreadable' };
    if (request.expectTarget === null) return { refused: 'expect_target_required' };
    if (!sameApprovalTarget(screen.approvalTarget, request.expectTarget)) return { refused: 'target_mismatch' };
  }
  const binding = observationBindingOf(observation);
  if (binding === null) return { refused: 'no_token_on_screen' };

  const labels = screen.options.map(option => option.label);
  const choice = resolveStrictChoice(screen.kind, labels, request.answer);
  if (!choice.ok) return { refused: choice.reason };
  facts.answer = { position: choice.index + 1, label: labels[choice.index] };
  if (screen.selectedPosition === null) return { refused: 'selection_unreadable' };

  if (!isScreenOpenAtBottom(frame)) return { refused: 'screen_not_open' };
  if (deps.startup.isWindowOpen()) return { refused: 'startup_window_open' };
  if (deps.startup.claimedWithin(STRICT_STARTUP_CLAIM_QUIET_MS)) return { refused: 'startup_trust_in_flight' };

  // Last, so a refusal above leaves the token for a corrected answer; consumed
  // here, before any key, so a failed send has still used it (fail closed).
  const verdict = consumeObservationToken(request.observationToken, binding, deps.now());
  if (!verdict.ok) return { refused: `token_${verdict.reason.replace(/-/g, '_')}` as StrictRespondReason };

  return { binding, selectedIndex: screen.selectedPosition - 1, targetIndex: choice.index };
}

/** One strict answer, under the session's lock. */
async function answerStrictly(request: StrictRespondRequest, deps: StrictRespondDeps): Promise<StrictRespondResult> {
  const facts: Facts = { request, observedKind: null, observedTarget: null, answer: null, keysSent: 0 };
  let checked: Awaited<ReturnType<typeof checkBeforeSending>>;
  try {
    checked = await checkBeforeSending(request, deps, facts);
  } catch {
    // prompt-observation threw (its `globalThis` state broken, …): a failure
    // before any key, reported rather than swallowed. The text is not logged.
    checked = { refused: 'observation_failed' };
  }
  if ('refused' in checked) return resultOf(facts, 40, checked.refused);

  const { binding, selectedIndex, targetIndex } = checked;
  const release = deps.startup.hold();
  try {
    // This answer is the trust screen's: the launch owes it no Enter any more.
    if (request.expectScreen === 'antigravity-trust') deps.startup.discardDebt();

    const keys = strictAnswerKeys(selectedIndex, targetIndex);
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) {
        // Where the keys sent so far put the highlight (1-based).
        const position = selectedIndex + 1 + (targetIndex > selectedIndex ? i : -i);
        const stopped = await awaitHighlight(deps, binding, position);
        if (stopped !== null) return resultOf(facts, 41, stopped);
        if (deps.startup.isWindowOpen()) return resultOf(facts, 41, 'screen_moved_mid_send');
      }
      try {
        await deps.sendKey(keys[i]);
      } catch {
        // tmux may have delivered it: counted, so this is never "not sent".
        facts.keysSent++;
        return resultOf(facts, 41, 'send_failed');
      }
      facts.keysSent++;
    }
  } finally {
    release();
  }

  const outcome = await awaitOutcome(deps, binding);
  if (outcome === 'advanced' || outcome === 'next-prompt') return resultOf(facts, 0, null, outcome);
  return resultOf(facts, 41, outcome === 'unchanged' ? 'outcome_unchanged' : 'outcome_indeterminate', outcome);
}

/** Run `fn` after every earlier holder of `sessionName`'s lock. */
async function withSessionLock<T>(sessionName: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionTails.get(sessionName) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  sessionTails.set(sessionName, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (sessionTails.get(sessionName) === tail) sessionTails.delete(sessionName);
  }
}

function forgetOldOperations(now: number): void {
  for (const [key, entry] of operations) {
    if (now - entry.at >= STRICT_OPERATION_TTL_MS && entry.result !== null) operations.delete(key);
  }
  while (operations.size > MAX_REMEMBERED_OPERATIONS) {
    const oldest = operations.keys().next().value;
    if (oldest === undefined) break;
    operations.delete(oldest);
  }
}

/**
 * Answer one strict request: deduplicated by operation id, serialised per
 * session. Never throws for a refusal; the result's `code` is the CLI's exit.
 */
export async function respondStrictly(
  request: StrictRespondRequest,
  deps: StrictRespondDeps
): Promise<StrictRespondResult> {
  const key = JSON.stringify([request.worktreeId, request.operationId]);
  const now = deps.now();
  forgetOldOperations(now);
  const earlier = operations.get(key);
  if (earlier !== undefined) {
    if (earlier.result !== null) return { ...earlier.result, replayed: true };
    return resultOf(
      { request, observedKind: null, observedTarget: null, answer: null, keysSent: 0 },
      41,
      'operation_in_progress'
    );
  }
  // Recorded before the first await, so a concurrent duplicate sees it.
  operations.set(key, { at: now, result: null });
  let result: StrictRespondResult;
  try {
    result = await withSessionLock(request.sessionName, () => answerStrictly(request, deps));
  } catch {
    // Only a fault past the checks gets here, where a key may have gone: kept
    // as "not known", so a retry with this id is not a second send.
    result = resultOf(
      { request, observedKind: null, observedTarget: null, answer: null, keysSent: 0 },
      41,
      'outcome_indeterminate'
    );
  }
  operations.set(key, { at: deps.now(), result });
  return result;
}

/** Forget every operation and lock. Test seam. */
export function clearStrictRespondState(): void {
  operations.clear();
  sessionTails.clear();
}
