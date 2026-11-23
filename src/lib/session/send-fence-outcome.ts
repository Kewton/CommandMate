/**
 * Issue #4534 (PR-B step 1, design v2 §3.2): what a refusal of a send was, read
 * in ONE order at every entry — the launch, copilot's `/model`, the body and
 * the dispatch, the relay delivery, `/terminal`, the timer.
 *
 * 1. The request's own ticket refused (`refusal`) → the target changed,
 *    whatever the error says after the tools' wraps.
 * 2. A typed refusal on the error's `cause` chain whose `requestId` is the
 *    request's own → its kind (target changed / reservation lost / fence
 *    misuse). Another request's refusal (a joined launch) is not this one's.
 * 3. A boundary refusal found neither way (`isInputBoundaryRefusal`, the role's
 *    refusals excepted) → the reservation was lost, as today.
 * 4. Anything else → `null`: the entry's own classification, as today.
 *
 * The state: `not-sent` only when nothing of the body can have reached the
 * pane — neither `bodyStarted` nor `dispatchUnknown` on the request's own
 * ticket; otherwise `indeterminate`. Never "not sent" for what is not known.
 *
 * Internal only (step 1): the outcome rides on the entries' own results and
 * is reported to {@link setSendFenceOutcomeObserver}; no route, CLI or
 * `lastSend` field carries it, and no public value changes here.
 *
 * Classifying never swallows: it returns data and leaves the error as it is.
 *
 * @module lib/session/send-fence-outcome
 */

import { isRoleConditionUnmet, readRoleLaunchRefusal } from '@/lib/agent-roles/launch-errors';
import { isInputBoundaryRefusal } from '@/lib/session/instance-input-lock';
import {
  currentSendRequestId,
  FenceMisuseError,
  readOwnSendTicket,
  SendTargetChangedError,
  type OwnSendTicket,
} from '@/lib/session/terminal-fence';

/**
 * A relay's reservation (or claim) is no longer this send's (design v2 §2.9):
 * the relay's boundary hook refused before the first key. The message is the
 * one the hook has always thrown; the request id is the open ticket's when it
 * was made (null with none).
 */
export class RelayReservationLostError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = currentSendRequestId()
  ) {
    super(message);
    this.name = 'RelayReservationLostError';
  }
}

/** What the refusal was (v2 §3.2, the reason's priority of §3.4). */
export type SendFenceOutcomeKind = 'target-changed' | 'reservation-lost' | 'fence-misuse';

/** One classified refusal. */
export interface SendFenceOutcome {
  kind: SendFenceOutcomeKind;
  state: 'not-sent' | 'indeterminate';
  /** The step of the order that found it (1–3). */
  order: 1 | 2 | 3;
  /** The refusal itself: the ticket's, the typed error found on the chain, or the boundary refusal. */
  refusal: unknown;
}

/** How deep a `cause` chain is followed. */
const MAX_CAUSE_DEPTH = 10;

function stateOf(own: OwnSendTicket | null): SendFenceOutcome['state'] {
  return own !== null && (own.bodyStarted || own.dispatchUnknown) ? 'indeterminate' : 'not-sent';
}

/** `error` and the errors it wraps (`cause`), outermost first; a loop ends the walk. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length <= MAX_CAUSE_DEPTH) {
    seen.add(current);
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function typedKind(error: unknown): SendFenceOutcomeKind | null {
  if (error instanceof SendTargetChangedError) return 'target-changed';
  if (error instanceof RelayReservationLostError) return 'reservation-lost';
  if (error instanceof FenceMisuseError) return 'fence-misuse';
  return null;
}

/** Order 2: the outermost typed refusal on the chain that is this request's. */
function ownTypedRefusal(error: unknown, requestId: string): { kind: SendFenceOutcomeKind; refusal: unknown } | null {
  for (const link of causeChain(error)) {
    const kind = typedKind(link);
    if (kind !== null && (link as { requestId?: unknown }).requestId === requestId) return { kind, refusal: link };
  }
  return null;
}

/** Order 3: a boundary refusal that is not the role's (#4115 keeps its own classification). */
function genericBoundaryRefusal(error: unknown): unknown {
  if (isRoleConditionUnmet(error) || readRoleLaunchRefusal(error) !== null) return null;
  return causeChain(error).find((link) => isInputBoundaryRefusal(link)) ?? null;
}

/**
 * Classify a send's failure by the order of v2 §3.2.
 *
 * @param error - What the entry caught
 * @param own - The request's own ticket (its handle, or {@link readOwnSendTicket}); null with none
 * @returns The refusal's kind and state, or null for order 4 (the entry's own classification)
 */
export function classifySendFenceOutcome(error: unknown, own: OwnSendTicket | null): SendFenceOutcome | null {
  const state = stateOf(own);
  if (own !== null && own.refusal !== null) {
    return { kind: 'target-changed', state, order: 1, refusal: own.refusal };
  }
  if (own !== null && typeof own.requestId === 'string' && own.requestId.length > 0) {
    const typed = ownTypedRefusal(error, own.requestId);
    if (typed !== null) return { kind: typed.kind, state, order: 2, refusal: typed.refusal };
  }
  const boundary = genericBoundaryRefusal(error);
  if (boundary !== null) return { kind: 'reservation-lost', state, order: 3, refusal: boundary };
  return null;
}

/** {@link classifySendFenceOutcome} with this context's open ticket (inside the entry's `run`). */
export function classifyOwnSendFenceOutcome(error: unknown): SendFenceOutcome | null {
  return classifySendFenceOutcome(error, readOwnSendTicket());
}

export { readOwnSendTicket };

/** The entries that classify (T16). */
export type SendFenceEntry = 'start' | 'model' | 'deliver' | 'relay' | 'terminal' | 'timer';

/** What one entry classified, and (relay) how it settled the payload. */
export interface SendFenceOutcomeEvent {
  entry: SendFenceEntry;
  outcome: SendFenceOutcome;
  settled?: string;
}

const slot = globalThis as unknown as {
  __commandmateSendFenceOutcome4534?: { observer: ((event: SendFenceOutcomeEvent) => void) | null };
};
slot.__commandmateSendFenceOutcome4534 ??= { observer: null };
const outcomeState = slot.__commandmateSendFenceOutcome4534;

/**
 * An entry's classified refusal, told to the observer. Nothing for `null`
 * (order 4). Never throws into the entry.
 */
export function reportSendFenceOutcome(entry: SendFenceEntry, outcome: SendFenceOutcome | null | undefined, settled?: string): void {
  if (outcome === null || outcome === undefined) return;
  const observer = outcomeState.observer;
  if (observer === null) return;
  try {
    observer(settled === undefined ? { entry, outcome } : { entry, outcome, settled });
  } catch {
    // An observer's failure never changes the send.
  }
}

/** Tests: the observer of the entries' outcomes (null to stop). */
export function setSendFenceOutcomeObserver(observer: ((event: SendFenceOutcomeEvent) => void) | null): void {
  outcomeState.observer = observer;
}
