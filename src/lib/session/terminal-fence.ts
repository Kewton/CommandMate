/**
 * One send's terminal changes, through one fence (Issue #4534).
 *
 * A send request — the send route, a relay delivery, `/terminal`'s command, a
 * timer — opens a TICKET for the target it resolved, the triple
 * `(worktree, instance, tool)`, and runs its work under it
 * (AsyncLocalStorage, innermost wins). Right before every change the work makes
 * to a terminal — a key, a kill, a paste, a geometry or environment change, an
 * OpenCode dispatch — in the same synchronous step, a GATE asks the ticket
 * whether the target is still the one it resolved, and throws when it is not.
 * A refused ticket refuses every later change in its scope; only the keys and
 * the kill of a RETRACTION ({@link asRetraction}) still go out. With no ticket,
 * or a closed one, a gate does nothing: the change goes out exactly as before.
 *
 * - A gate is one line right before the call it guards; no function is wrapped.
 * - A creation (`createSession`) is a BATCH: confirmed once at its head and then
 *   finished as one change, so a refusal never leaves a placeholder-only session.
 *   The batch token is made only by {@link fenceBatchOpen} and is good until
 *   {@link fenceBatchEnd}; a single gate hands nothing back to keep.
 * - `closed` is its own field and is read first: a closed ticket — refused or
 *   not — is the same as none.
 * - The DETECTOR: an entry counts its open sends per tmux session name. A
 *   send-only layer entered with no open ticket while a send to that session is
 *   open throws `FenceMisuseError('unticketed')`. With none open it does nothing.
 *
 * This module imports nothing but `node:async_hooks` (design §2.2): the gates
 * sit in `tmux.ts` and the input lock, which everything imports.
 *
 * @module lib/session/terminal-fence
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** What a single gate is about to change. */
export type FenceGateKind = 'key' | 'kill' | 'geometry' | 'env' | 'paste' | 'dispatch';

/** Why a ticket's target is no longer the one it resolved. */
export type FenceRefusalReason = 'worktree-gone' | 'target-gone' | 'tool-changed' | 'dispatch-changed' | 'unreadable';

/** The target a ticket was opened for. */
export interface SendTarget {
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
}

/** `resolved`: an entry that resolved its target; `timer`: a timer's own row (design v2 §2.3). */
export type SendTicketKind = 'resolved' | 'timer';

/** What an entry opens a ticket with ({@link openSendTicket}). */
export interface SendTicketInit {
  target: SendTarget;
  /** How the entry resolved the target (`roster`, `worktree-default`, …); null when it does not resolve. */
  resolvedBy: string | null;
  kind: SendTicketKind;
  /**
   * Synchronous: whether the target is still the one resolved. Null when it is;
   * a throw is read as `unreadable`.
   */
  confirm: () => FenceRefusalReason | null;
  /** The tmux session names the detector counts this send under. Never empty. */
  names: readonly string[];
}

export const SEND_TARGET_CHANGED_CODE = 'SEND_TARGET_CHANGED';
export const SEND_FENCE_MISUSE_CODE = 'SEND_FENCE_MISUSE';

/** A gate refused: the change it guarded never started. */
export class SendTargetChangedError extends Error {
  readonly code = SEND_TARGET_CHANGED_CODE;
  readonly delivery = 'not-started' as const;
  constructor(
    readonly reason: FenceRefusalReason,
    readonly requestId: string,
    options?: { cause?: unknown }
  ) {
    super(`send target changed: ${reason}`, options);
    this.name = 'SendTargetChangedError';
  }
}

/** Why the fence was used wrongly (a bug of the caller, never of the target). */
export type FenceMisuseReason = 'unticketed' | 'not-a-batch' | 'batch-ended' | 'batch-of-another-send' | 'no-name';

/** The fence was used wrongly; nothing was changed by the call that threw. */
export class FenceMisuseError extends Error {
  readonly code = SEND_FENCE_MISUSE_CODE;
  readonly delivery = 'not-started' as const;
  constructor(
    readonly reason: FenceMisuseReason,
    what: string,
    /** The request whose ticket was open when it was misused; null with none (PR-B: classification order 2). */
    readonly requestId: string | null = null
  ) {
    super(`send fence ${reason}: ${what}`);
    this.name = 'FenceMisuseError';
  }
}

/** Whether `error` is the fence's own refusal (a catch that swallows or wraps must throw it on). */
export function isFenceRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === SEND_TARGET_CHANGED_CODE || code === SEND_FENCE_MISUSE_CODE;
}

/**
 * INV-catch (Issue #4534 r3): the first statement of a driver's `catch` around
 * a gated call. The fence's refusal goes on as itself — never swallowed, never
 * wrapped; anything else is left to the catch.
 *
 * @throws The refusal, unchanged, when `error` is one
 */
export function rethrowFenceRefusal(error: unknown): void {
  if (isFenceRefusal(error)) throw error;
}

interface Ticket {
  readonly requestId: string;
  readonly target: SendTarget;
  readonly resolvedBy: string | null;
  readonly kind: SendTicketKind;
  readonly confirm: () => FenceRefusalReason | null;
  refusal: SendTargetChangedError | null;
  closed: boolean;
  /** `noteInputStart` passed: some of the body may be on the pane. */
  bodyStarted: boolean;
  /** `noteDispatchStart` passed and the dispatch was not settled `not_sent`. */
  dispatchUnknown: boolean;
  readonly names: Set<string>;
}

interface Retraction {
  readonly site: string;
  active: boolean;
}

/** How a gate let a change through (tests: the fake process's permit). */
export type FenceGateMode = 'bare' | 'ticketed' | 'batch' | 'retraction';

/** One gate that let a change through; `names` are the open ticket's (empty for `bare`). */
export interface FenceGateEvent {
  kind: FenceGateKind | 'create';
  mode: FenceGateMode;
  names: readonly string[];
}

interface FenceState {
  readonly tickets: AsyncLocalStorage<Ticket>;
  readonly retractions: AsyncLocalStorage<Retraction>;
  readonly openByName: Map<string, number>;
  observer: ((event: FenceGateEvent) => void) | null;
  seq: number;
}

const globalSlot = globalThis as unknown as { __commandmateSendFence4534?: FenceState };
globalSlot.__commandmateSendFence4534 ??= {
  tickets: new AsyncLocalStorage<Ticket>(),
  retractions: new AsyncLocalStorage<Retraction>(),
  openByName: new Map<string, number>(),
  observer: null,
  seq: 0,
};
const state: FenceState = globalSlot.__commandmateSendFence4534;

/** The ticket in this context, unless there is none or it is closed (R8: `closed` first). */
function liveTicket(): Ticket | null {
  const ticket = state.tickets.getStore();
  if (ticket === undefined || ticket.closed) return null;
  return ticket;
}

function observe(kind: FenceGateKind | 'create', mode: FenceGateMode, ticket: Ticket | null): void {
  const observer = state.observer;
  if (observer === null) return;
  observer({ kind, mode, names: ticket === null ? [] : [...ticket.names] });
}

/** Ask the ticket; a refusal is kept on it and thrown (R7). */
function confirmOrRefuse(ticket: Ticket): void {
  if (ticket.refusal !== null) throw ticket.refusal;
  let verdict: FenceRefusalReason | null;
  try {
    verdict = ticket.confirm();
  } catch (error) {
    ticket.refusal = new SendTargetChangedError('unreadable', ticket.requestId, { cause: error });
    throw ticket.refusal;
  }
  if (verdict !== null) {
    ticket.refusal = new SendTargetChangedError(verdict, ticket.requestId);
    throw ticket.refusal;
  }
}

function inRetraction(): boolean {
  return state.retractions.getStore()?.active === true;
}

/**
 * Right before one terminal change, in the same synchronous step. Returns
 * nothing: there is nothing to keep for a later change.
 *
 * @throws {SendTargetChangedError} The open ticket's target changed (or it was refused before)
 */
export function fenceGate(kind: FenceGateKind): void {
  const ticket = liveTicket();
  if (ticket === null) {
    observe(kind, 'bare', null);
    return;
  }
  if (inRetraction() && (kind === 'key' || kind === 'kill')) {
    observe(kind, 'retraction', ticket);
    return;
  }
  confirmOrRefuse(ticket);
  observe(kind, 'ticketed', ticket);
}

/**
 * A creation in progress: made only by {@link fenceBatchOpen}, good until
 * {@link fenceBatchEnd}. Not exported, and its private fields make it nominal:
 * an object shaped like one is not one, for the compiler and at run time.
 */
class FenceBatchToken {
  readonly #ticket: Ticket | null;
  #active = true;

  constructor(ticket: Ticket | null) {
    this.#ticket = ticket;
  }

  static isToken(value: unknown): value is FenceBatchToken {
    return typeof value === 'object' && value !== null && #ticket in value;
  }

  static ticketOf(token: FenceBatchToken): Ticket | null {
    return token.#ticket;
  }

  static isActive(token: FenceBatchToken): boolean {
    return token.#active;
  }

  static end(token: FenceBatchToken): void {
    token.#active = false;
  }
}

/** The token a creation's further steps take ({@link fenceBatchStep}). */
export type FenceBatch = FenceBatchToken;

/**
 * The head of a creation: confirmed like a single gate, and the batch its
 * further steps continue.
 *
 * @throws {SendTargetChangedError} As {@link fenceGate}
 */
export function fenceBatchOpen(kind: 'create'): FenceBatch {
  const ticket = liveTicket();
  if (ticket === null) {
    observe(kind, 'bare', null);
    return new FenceBatchToken(null);
  }
  confirmOrRefuse(ticket);
  observe(kind, 'ticketed', ticket);
  return new FenceBatchToken(ticket);
}

/**
 * A further step of the creation `batch` opened: not confirmed and not refused
 * — the creation is finished as one change.
 *
 * @throws {FenceMisuseError} `not-a-batch` / `batch-ended` / `batch-of-another-send`
 *   while a ticket is open; nothing is changed then
 */
export function fenceBatchStep(batch: FenceBatch): void {
  const ticket = liveTicket();
  if (ticket === null) {
    observe('create', 'bare', null);
    return;
  }
  if (!FenceBatchToken.isToken(batch)) {
    throw new FenceMisuseError('not-a-batch', 'a step with something no creation opened', ticket.requestId);
  }
  if (!FenceBatchToken.isActive(batch)) throw new FenceMisuseError('batch-ended', 'a step after its creation ended', ticket.requestId);
  if (FenceBatchToken.ticketOf(batch) !== ticket) {
    throw new FenceMisuseError('batch-of-another-send', 'a step under another ticket', ticket.requestId);
  }
  observe('create', 'batch', ticket);
}

/** The creation is over, however it ended (`createSession`'s `finally`). */
export function fenceBatchEnd(batch: FenceBatch | undefined): void {
  if (FenceBatchToken.isToken(batch)) FenceBatchToken.end(batch);
}

/**
 * Before a boundary is told (`noteInputStart`, `noteDispatchStart`): confirms
 * the open ticket and changes nothing (R9).
 *
 * @throws {SendTargetChangedError} As {@link fenceGate}
 */
export function fenceConfirm(): void {
  const ticket = liveTicket();
  if (ticket !== null) confirmOrRefuse(ticket);
}

/**
 * Before an OpenCode dispatch is told (design v2 §2.8): the open ticket, and
 * that the dispatch still goes where the ticket's target is served — the same
 * instance, and (`stillSame`, synchronous reads) the port, the live
 * subscription and the session it would post to. A mismatch is the ticket's
 * refusal `dispatch-changed`. With no open ticket nothing is read.
 *
 * @throws {SendTargetChangedError} As {@link fenceGate}, or `dispatch-changed`
 */
export function fenceConfirmDispatch(target: SendTarget, stillSame: () => boolean): void {
  const ticket = liveTicket();
  if (ticket === null) return;
  confirmOrRefuse(ticket);
  let same: boolean;
  try {
    same =
      target.worktreeId === ticket.target.worktreeId &&
      target.instanceId === ticket.target.instanceId &&
      target.cliToolId === ticket.target.cliToolId &&
      stillSame();
  } catch (error) {
    ticket.refusal = new SendTargetChangedError('unreadable', ticket.requestId, { cause: error });
    throw ticket.refusal;
  }
  if (!same) {
    ticket.refusal = new SendTargetChangedError('dispatch-changed', ticket.requestId);
    throw ticket.refusal;
  }
}

/** `noteInputStart` passed: the body may start reaching the pane. */
export function noteFenceBodyStarted(): void {
  const ticket = liveTicket();
  if (ticket !== null) ticket.bodyStarted = true;
}

/** `noteDispatchStart` passed: a dispatch may have gone out. */
export function noteFenceDispatchStarted(): void {
  const ticket = liveTicket();
  if (ticket !== null) ticket.dispatchUnknown = true;
}

/** The dispatch was settled `not_sent`: nothing went out after all. */
export function noteFenceDispatchNotSent(): void {
  const ticket = liveTicket();
  if (ticket !== null) ticket.dispatchUnknown = false;
}

/** What the request's own open ticket says, when it refused (classification order 1). */
export interface OwnFenceRefusal {
  refusal: SendTargetChangedError;
  bodyStarted: boolean;
  dispatchUnknown: boolean;
}

/** The open ticket's refusal in this context, read before it closes; null when it did not refuse. */
export function readOwnFenceRefusal(): OwnFenceRefusal | null {
  const ticket = liveTicket();
  if (ticket === null || ticket.refusal === null) return null;
  return { refusal: ticket.refusal, bodyStarted: ticket.bodyStarted, dispatchUnknown: ticket.dispatchUnknown };
}

/**
 * What a request's own ticket says, refused or not (PR-B: the classification
 * reads it — order 1 the refusal, order 2 the request id — and the flags give
 * the state).
 */
export interface OwnSendTicket {
  readonly requestId: string;
  readonly refusal: SendTargetChangedError | null;
  readonly bodyStarted: boolean;
  readonly dispatchUnknown: boolean;
}

/** The open ticket of this context as {@link OwnSendTicket}; null when there is none (or it is closed). */
export function readOwnSendTicket(): OwnSendTicket | null {
  const ticket = liveTicket();
  if (ticket === null) return null;
  return {
    requestId: ticket.requestId,
    refusal: ticket.refusal,
    bodyStarted: ticket.bodyStarted,
    dispatchUnknown: ticket.dispatchUnknown,
  };
}

/** The request id of the open ticket in this context; null with none (a refusal made here names it). */
export function currentSendRequestId(): string | null {
  return liveTicket()?.requestId ?? null;
}

/** An open ticket, as its entry holds it. */
export interface SendTicketHandle extends OwnSendTicket {
  /** Run `fn` under the ticket; `fn`'s own value (its promise) comes back as is (R6). */
  run<T>(fn: () => T): T;
  /** Close it (idempotent). A closed ticket is the same as none. */
  close(): void;
}

function countName(name: string, delta: 1 | -1): void {
  const next = (state.openByName.get(name) ?? 0) + delta;
  if (next <= 0) state.openByName.delete(name);
  else state.openByName.set(name, next);
}

/**
 * Open a ticket. The entry runs its work with `run` and closes it when the
 * request is over.
 *
 * @throws {FenceMisuseError} `no-name`: a ticket the detector could not count
 */
export function openSendTicket(init: SendTicketInit): SendTicketHandle {
  const names = new Set(init.names);
  if (names.size === 0 || [...names].some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new FenceMisuseError('no-name', 'a ticket with no session name');
  }
  state.seq += 1;
  const ticket: Ticket = {
    requestId: `send-${process.pid}-${state.seq}`,
    target: { ...init.target },
    resolvedBy: init.resolvedBy,
    kind: init.kind,
    confirm: init.confirm,
    refusal: null,
    closed: false,
    bodyStarted: false,
    dispatchUnknown: false,
    names,
  };
  for (const name of names) countName(name, 1);
  return {
    requestId: ticket.requestId,
    run: (fn) => state.tickets.run(ticket, fn),
    close: () => {
      if (ticket.closed) return;
      ticket.closed = true;
      for (const name of ticket.names) countName(name, -1);
    },
    get refusal() {
      return ticket.refusal;
    },
    get bodyStarted() {
      return ticket.bodyStarted;
    },
    get dispatchUnknown() {
      return ticket.dispatchUnknown;
    },
  };
}

/**
 * An entry with one call: open, run `fn` under it, close when `fn` settles.
 * `fn`'s own promise comes back — no `await`, no `finally` in between (R6).
 * `onOpen` (PR-B) hands the entry its handle, so the entry's own `catch` can
 * classify by it after the ticket closed.
 */
export function runWithSendTicket<T>(
  init: SendTicketInit,
  fn: () => Promise<T>,
  onOpen?: (ticket: SendTicketHandle) => void
): Promise<T> {
  const handle = openSendTicket(init);
  onOpen?.(handle);
  let promise: Promise<T>;
  try {
    promise = handle.run(fn);
  } catch (error) {
    handle.close();
    throw error;
  }
  promise.then(handle.close, handle.close);
  return promise;
}

/**
 * Take back what this request itself put in (R7). Inside, the keys and the
 * kill of a refused ticket still go out; nothing else does. It ends when `fn`
 * settles, and `fn`'s own promise comes back.
 */
export function asRetraction<T>(site: string, fn: () => Promise<T>): Promise<T> {
  const scope: Retraction = { site, active: true };
  const end = (): void => {
    scope.active = false;
  };
  let promise: Promise<T>;
  try {
    promise = state.retractions.run(scope, fn);
  } catch (error) {
    end();
    throw error;
  }
  promise.then(end, end);
  return promise;
}

/**
 * The detector (B1 (b)), at the top of a send-only layer: entered with no open
 * ticket while a send to `sessionName` is open, it throws. Entered under a
 * ticket that does not know `sessionName` (a dropped legacy alias, #2866), the
 * ticket counts it from here on.
 *
 * @throws {FenceMisuseError} `unticketed`
 */
export function enterSendLayer(layer: string, sessionName: string): void {
  const ticket = liveTicket();
  if (ticket !== null) {
    if (!ticket.names.has(sessionName)) {
      ticket.names.add(sessionName);
      countName(sessionName, 1);
    }
    return;
  }
  if ((state.openByName.get(sessionName) ?? 0) > 0) {
    throw new FenceMisuseError('unticketed', `layer ${layer} on ${sessionName}`);
  }
}

/** Tests: the gate observer (the fake process's permits). */
export function setFenceObserver(observer: ((event: FenceGateEvent) => void) | null): void {
  state.observer = observer;
}

/** Tests: how many sends are open under `name`. */
export function openSendCount(name: string): number {
  return state.openByName.get(name) ?? 0;
}

/** Tests: forget every count and the observer. */
export function resetFenceForTests(): void {
  state.openByName.clear();
  state.observer = null;
}
