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
 * (`StrictRespondOutcome`); only `advanced`, `next-prompt` and `session-ended`
 * are success. A
 * screen that stayed is never answered again from here. agy's `No, exit`
 * leaves the tmux session up with the shell in it, a screen no reader names
 * (`unknown`): that read is `session-ended` only when tmux also says the
 * pane's foreground command is a shell again (Issue #3788). A command that
 * cannot be read, or is still the agent, leaves it `indeterminate`.
 *
 * ## Serialised, and deduplicated
 *
 * Strict answers to one session run one at a time. Operation ids are kept per
 * worktree and session, with what the request asked: a reused id that asks the
 * same is answered with the stored result and sends nothing (one whose first
 * request is still running is exit 41); one that asks something else is exit
 * 41 `operation_id_conflict`. A refusal (exit 40) is not kept, so the id can be
 * sent again with a corrected answer.
 *
 * Auto-Yes on the instance refuses a permission dialog (`auto_yes_active`): its
 * poller answers those itself, and an Enter of ours could land on the dialog
 * it brings up next. The trust screen it never answers.
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
import { isShellPaneCommand } from '@/lib/detection/shared/shell-pane-command';
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
  /**
   * Whether the instance's Auto-Yes is on. Its poller answers permission
   * dialogs on its own, so a strict answer to one could race it.
   */
  autoYesActive(): boolean;
  /**
   * The pane's foreground command (`#{pane_current_command}`), or null when
   * tmux cannot say (Issue #3788). Read only after the Enter, to tell an agent
   * that exited back to its shell from a screen that could not be read. Absent,
   * null or throwing: never taken as the agent having exited.
   * The server passes `cli-session`'s `readSessionPaneCommand` (the #1922
   * gateway to tmux).
   */
  paneCommand?(): Promise<string | null>;
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
  var __strictRespondOperations: Map<string, OperationEntry> | undefined;
}

/** One remembered operation: what was asked, and its result once it has one. */
interface OperationEntry {
  at: number;
  /** {@link requestFingerprint} of the request that took the id. */
  fingerprint: string;
  result: StrictRespondResult | null;
}

const sessionTails = getOrInitGlobal('__strictRespondSessionTails', () => new Map<string, Promise<void>>());
const operations = getOrInitGlobal('__strictRespondOperations', () => new Map<string, OperationEntry>());

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
  operation_id_conflict: 'This operation id was already used for another request; nothing was sent for this one.',
  operation_table_full: 'Too many strict answers are running to take one more; nothing was sent.',
  auto_yes_active:
    'Auto-Yes is on for this instance and answers permission dialogs itself: disable it first (commandmate auto-yes <id> --disable).',
  server_unreachable: 'The server could not be reached.',
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
    message:
      reason !== null
        ? MESSAGES[reason]
        : outcome === 'session-ended'
          ? 'Answered: the session ended (agy exits on "No, exit").'
          : `Answered: the screen ${outcome === 'next-prompt' ? 'moved to the next prompt' : 'advanced'}.`,
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
  if (observation.status === 'unavailable' || observation.screen === null) return 'session-ended';
  const kind = observation.screen.kind;
  if (!isDecisionKind(kind)) return 'advanced';
  if (sameAppearance(binding, observationBindingOf(observation))) return 'unchanged';
  if (kind === 'unknown') return 'indeterminate';
  return 'next-prompt';
}

/** The outcomes that are success: the screen did what an answer does. */
function isAnsweredOutcome(outcome: StrictRespondOutcome): boolean {
  return outcome === 'advanced' || outcome === 'next-prompt' || outcome === 'session-ended';
}

/** Whether tmux says, for certain, that the pane is back at a shell. */
async function agentExitedToShell(deps: StrictRespondDeps): Promise<boolean> {
  if (deps.paneCommand === undefined) return false;
  try {
    const command = await deps.paneCommand();
    return command !== null && isShellPaneCommand(command);
  } catch {
    return false;
  }
}

/** Read for a few seconds after the Enter; the first answered outcome ends it. */
async function awaitOutcome(deps: StrictRespondDeps, binding: ObservationTokenBinding): Promise<StrictRespondOutcome> {
  const deadline = deps.now() + STRICT_OUTCOME_WAIT_MS;
  let outcome: StrictRespondOutcome = 'indeterminate';
  for (;;) {
    await deps.sleep(STRICT_READ_INTERVAL_MS);
    const read = await deps.read();
    outcome = outcomeOf(read, binding);
    // A screen that was read and that no reader names, with the shell back in
    // front: the agent has exited (agy on `No, exit`). Not for a read that
    // failed — the frame is not known — nor for a screen that stayed.
    if (outcome === 'indeterminate' && read.ok && (await agentExitedToShell(deps))) outcome = 'session-ended';
    if (isAnsweredOutcome(outcome)) return outcome;
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
  // The poller answers permission dialogs itself; the trust screen it never answers.
  if (screen.kind === 'antigravity-permission' && deps.autoYesActive()) return { refused: 'auto_yes_active' };

  // Last, so a refusal above leaves the token for a corrected answer; consumed
  // here, before any key, so a failed send has still used it (fail closed).
  const verdict = consumeObservationToken(request.observationToken, binding, deps.now());
  if (!verdict.ok) return { refused: `token_${verdict.reason.replace(/-/g, '_')}` as StrictRespondReason };

  return { binding, selectedIndex: screen.selectedPosition - 1, targetIndex: choice.index };
}

/** One strict answer, under the session's lock. */
async function answerStrictly(
  request: StrictRespondRequest,
  deps: StrictRespondDeps,
  facts: Facts
): Promise<StrictRespondResult> {
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
    const keys = strictAnswerKeys(selectedIndex, targetIndex);
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) {
        // Where the keys sent so far put the highlight (1-based).
        const position = selectedIndex + 1 + (targetIndex > selectedIndex ? i : -i);
        const stopped = await awaitHighlight(deps, binding, position);
        if (stopped !== null) return resultOf(facts, 41, stopped);
        if (deps.startup.isWindowOpen()) return resultOf(facts, 41, 'screen_moved_mid_send');
        if (request.expectScreen === 'antigravity-permission' && deps.autoYesActive()) {
          return resultOf(facts, 41, 'auto_yes_active');
        }
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
    // Once any key reached the trust screen the launch owes it nothing: its
    // Enter would confirm a highlight this answer moved (an arrow sent, then a
    // stop) or answer the screen a second time (our Enter sent). Dropped here,
    // on every way out after a key and before the hold ends — while held it
    // could not be claimed, so it never races our own Enter. With no key sent
    // the debt is left for the launch.
    if (facts.keysSent > 0 && request.expectScreen === 'antigravity-trust') deps.startup.discardDebt();
    release();
  }

  const outcome = await awaitOutcome(deps, binding);
  if (isAnsweredOutcome(outcome)) return resultOf(facts, 0, null, outcome);
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

/**
 * Forget expired results, then — oldest first — finished ones until there is
 * room for one more. A running operation is never forgotten: its id must keep
 * refusing a second send. False when running ones alone fill the table.
 */
function makeRoomForOperation(now: number): boolean {
  for (const [key, entry] of operations) {
    if (entry.result !== null && now - entry.at >= STRICT_OPERATION_TTL_MS) operations.delete(key);
  }
  for (const [key, entry] of operations) {
    if (operations.size < MAX_REMEMBERED_OPERATIONS) break;
    if (entry.result !== null) operations.delete(key);
  }
  return operations.size < MAX_REMEMBERED_OPERATIONS;
}

/** What a request asks: a reused operation id must ask the same, or it is another request. */
function requestFingerprint(request: StrictRespondRequest): string {
  return JSON.stringify([request.expectScreen, request.answer, request.observationToken, request.expectTarget]);
}

/**
 * Answer one strict request: deduplicated by operation id, serialised per
 * session. Never throws for a refusal; the result's `code` is the CLI's exit.
 */
export async function respondStrictly(
  request: StrictRespondRequest,
  deps: StrictRespondDeps
): Promise<StrictRespondResult> {
  // The session is in the key: one id sent to two instances is two operations.
  const key = JSON.stringify([request.worktreeId, request.sessionName, request.operationId]);
  const fingerprint = requestFingerprint(request);
  const now = deps.now();
  const nothingYet = (reason: StrictRespondReason): StrictRespondResult =>
    resultOf({ request, observedKind: null, observedTarget: null, answer: null, keysSent: 0 }, 41, reason);
  let earlier = operations.get(key);
  // An expired result is forgotten here, not only at the next sweep.
  if (earlier !== undefined && earlier.result !== null && now - earlier.at >= STRICT_OPERATION_TTL_MS) {
    operations.delete(key);
    earlier = undefined;
  }
  if (earlier !== undefined) {
    if (earlier.fingerprint !== fingerprint) return nothingYet('operation_id_conflict');
    if (earlier.result !== null) return { ...earlier.result, replayed: true };
    return nothingYet('operation_in_progress');
  }
  if (!makeRoomForOperation(now)) return nothingYet('operation_table_full');
  // Recorded before the first await, so a concurrent duplicate sees it.
  operations.set(key, { at: now, fingerprint, result: null });
  // Shared with the answer, so a fault part-way reports the keys actually sent.
  const facts: Facts = { request, observedKind: null, observedTarget: null, answer: null, keysSent: 0 };
  let result: StrictRespondResult;
  try {
    result = await withSessionLock(request.sessionName, () => answerStrictly(request, deps, facts));
  } catch {
    // Only a fault past the checks gets here, where a key may have gone: kept
    // as "not known", so a retry with this id is not a second send.
    result = resultOf(facts, 41, 'outcome_indeterminate');
  }
  // A refusal sent nothing and is not kept: the caller may correct the label
  // and send again with the same id. A result with keys behind it (0 / 41) is
  // kept, so the id reads it back instead of sending twice.
  if (result.code === 40) operations.delete(key);
  else operations.set(key, { at: deps.now(), fingerprint, result });
  return result;
}

/** Forget every operation and lock. Test seam. */
export function clearStrictRespondState(): void {
  operations.clear();
  sessionTails.clear();
}
