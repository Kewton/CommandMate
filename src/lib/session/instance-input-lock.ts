/**
 * One writer at a time per agent composer (Issue #3945).
 *
 * Several entry points type into the same tmux composer — `POST /send` (CLI
 * `send` / `ask`, chat, phone, session tiles), the timer manager, relay
 * delivery, the terminal route — and until this module nothing ordered them.
 * A send that took the composer back (`withdrawUnsentBody`, the pre-send clear)
 * could therefore erase another send's text, and a late codex paste placeholder
 * (`[Pasted Content N chars]`, #3937) could not be told apart from the next
 * send's: the placeholder carries only a count.
 *
 * Four things live here, all per tmux session name (one per worktree+instance,
 * `resolveSessionName`):
 *
 * 1. **The lock.** {@link withInstanceInputLock} runs a function as the
 *    composer's only writer. Waiters queue FIFO; a waiter that is not admitted
 *    within {@link INSTANCE_INPUT_LOCK_WAIT_MS} is removed from the queue and
 *    never runs (`InstanceInputLockTimeoutError`, nothing typed). Once admitted
 *    there is no processing deadline: ownership passes on only when the owner's
 *    function settles, on every path (`finally`).
 * 2. **The ticket.** Every admission takes a fresh, never-reused number. The
 *    owner's ticket is "current" until it releases or the session is replaced
 *    ({@link invalidateInstanceInput}); every key a sender sends is preceded by
 *    `ticket.isCurrent()`, so work a stale owner still has in flight cannot
 *    reach the next owner's composer.
 * 3. **Ownership in the async context.** A call made inside an owner's function
 *    (the sender inside `sendUserMessage`'s lock) joins the owner's ticket
 *    instead of queueing behind itself; no lock is ever acquired twice. A
 *    context whose ticket was revoked is refused, never given a new one.
 * 4. **The carried paste mark.** A send whose body may still arrive after it
 *    has given up (an `unseen` paste, a read that threw, a clear that could not
 *    be confirmed) leaves a mark. The next owner does not start typing until the
 *    mark expires ({@link CARRIED_PASTE_MARK_TTL_MS}): a placeholder of the same
 *    count as its own body would be indistinguishable from it. The mark belongs
 *    to the session, not to the send that left it, so the next owner is the one
 *    that handles it, and the stale sender cannot resume.
 *
 * Issue #3952 adds a second way to hold it. The answers the server types at a
 * screen it read — prompt answers, Auto-Yes, the strict respond, plan-review
 * keys, readiness dialogs — are `shared` writers: kept off a send's composer
 * and a send off theirs, but not ordered against each other
 * ({@link InstanceInputMode}). {@link answerUnderInstanceInputLock} reads the
 * screen again when a send came between the answer's read and its keys. A
 * person's own keys (the terminal, `direct-input`, special keys) and the
 * interrupt's Escape do not take part, by decision.
 *
 * In memory and on `globalThis` (`getOrInitGlobal`) for the reason every shared
 * map in this subsystem is: the send route, the terminal route and the clear
 * route are separate bundles under `next dev`, and a lock per bundle would order
 * nothing. A server restart forgets every mark — a placeholder that arrives
 * after a restart is left to the next send's pre-send clear, as it was before
 * this module. The lock is per process: two servers sharing one tmux server are
 * not ordered by it (out of scope for #3945).
 *
 * @module lib/session/instance-input-lock
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrInitGlobal } from '@/lib/global-state';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session/instance-input-lock');

/**
 * How long a writer waits to be admitted before it gives up without typing.
 *
 * Has to cover what can be ahead of it: an owner's whole send (a pasted body's
 * 2 s check plus {@link LATE_PASTE_OBSERVE_MS}, a typed codex body's 5 s,
 * the clear passes and the read-back), and a carried mark's
 * {@link CARRIED_PASTE_MARK_TTL_MS}. A unit test pins mark < this.
 */
export const INSTANCE_INPUT_LOCK_WAIT_MS = 60_000;

/**
 * How long a send that saw nothing of its paste keeps watching the composer,
 * still holding the lock, before it gives up (Issue #3945 stage 4).
 *
 * PROVISIONAL: #3937 has not yet measured how late codex 0.164.0 draws a
 * placeholder. Three seconds beyond the 2 s check is a guess, to be replaced by
 * that measurement.
 */
export const LATE_PASTE_OBSERVE_MS = 3_000;

/**
 * How long a carried paste mark holds the next send off the composer.
 *
 * PROVISIONAL, as {@link LATE_PASTE_OBSERVE_MS}. It must stay below
 * {@link INSTANCE_INPUT_LOCK_WAIT_MS}, or waiting it out would itself make the
 * next send `not-sent`.
 */
export const CARRIED_PASTE_MARK_TTL_MS = 8_000;

/** `code` on the error a writer gets when it was not admitted in time. */
export const INSTANCE_INPUT_LOCK_TIMEOUT_CODE = 'INSTANCE_INPUT_LOCK_TIMEOUT';

/** `code` on the error a waiter gets when its session was replaced while it waited. */
export const INSTANCE_INPUT_SESSION_REPLACED_CODE = 'INSTANCE_INPUT_SESSION_REPLACED';

/** `code` on the error a call from a revoked owner's context gets. */
export const INSTANCE_INPUT_OWNERSHIP_LOST_CODE = 'INSTANCE_INPUT_OWNERSHIP_LOST';

/** The owner's handle. */
export interface InstanceInputTicket {
  readonly sessionName: string;
  /** Never reused, across sessions and module reloads. */
  readonly generation: number;
  /** Whether the owner had to queue for the composer (diagnostics and tests). */
  readonly waited: boolean;
  /**
   * `exclusive` for a send's body, a clear, copilot's own commands; `shared` for
   * an answer to a screen (Issue #3952), which excludes sends but not other
   * answers.
   */
  readonly mode: InstanceInputMode;
  /** True while this ticket still owns the session's composer. */
  isCurrent(): boolean;
}

/**
 * How a writer holds the composer (Issue #3952).
 *
 * - `exclusive`: alone — no other writer of either mode. Every send of a body,
 *   the clear, copilot's selection-list and `/model` keys (#3945).
 * - `shared`: with other `shared` writers, never with an `exclusive` one. The
 *   answers the server types at a screen it read — readiness dialogs, prompt
 *   answers, Auto-Yes, plan-review keys, the strict respond. They are kept off a
 *   send's composer and a send off theirs; two answers were never ordered
 *   against each other and still are not (their own holds, #3880, do that).
 */
export type InstanceInputMode = 'exclusive' | 'shared';

/** A body that may still arrive in the composer after its send gave up. */
export interface CarriedPasteMark {
  /** The generation of the send that left it. */
  originGeneration: number;
  /** Epoch ms it was left. */
  at: number;
  /** Epoch ms after which it no longer holds sends off. */
  expiresAt: number;
}

interface Waiter {
  mode: InstanceInputMode;
  admit: (ticket: TicketImpl) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LockEntry {
  /** The `exclusive` owner. */
  owner: TicketImpl | null;
  /** The `shared` owners (Issue #3952); never non-empty together with `owner`. */
  shared: Set<TicketImpl>;
  queue: Waiter[];
  mark: CarriedPasteMark | null;
}

class TicketImpl implements InstanceInputTicket {
  released = false;
  revoked = false;

  constructor(
    readonly sessionName: string,
    readonly generation: number,
    readonly waited: boolean,
    readonly mode: InstanceInputMode = 'exclusive'
  ) {}

  isCurrent(): boolean {
    if (this.released || this.revoked) return false;
    const entry = entries.get(this.sessionName);
    return this.mode === 'shared' ? entry?.shared.has(this) === true : entry?.owner === this;
  }
}

/** Thrown, before anything runs, by a writer that was not admitted in time. */
export class InstanceInputLockTimeoutError extends Error {
  readonly code = INSTANCE_INPUT_LOCK_TIMEOUT_CODE;

  constructor(sessionName: string, waitedMs: number) {
    super(
      `Another send to session ${sessionName} held its composer for over ${waitedMs}ms; ` +
        'input lock not acquired, nothing was typed (Issue #3945).'
    );
    this.name = 'InstanceInputLockTimeoutError';
  }
}

/**
 * Thrown, before anything runs, by a call made from a context whose ticket was
 * revoked (review-1 #1): the session was replaced while the owner was working
 * (a readiness wait, a relaunch check). Such a call is the old request; it must
 * not take a fresh ticket and type into the new session.
 */
export class InstanceInputOwnershipLostError extends Error {
  readonly code = INSTANCE_INPUT_OWNERSHIP_LOST_CODE;

  constructor(sessionName: string) {
    super(
      `Session ${sessionName} was replaced while this send held its composer; ` +
        'input lock lost, nothing was typed (Issue #3945).'
    );
    this.name = 'InstanceInputOwnershipLostError';
  }
}

/** Thrown to a waiter whose session was killed or recreated while it waited. */
export class InstanceInputSessionReplacedError extends Error {
  readonly code = INSTANCE_INPUT_SESSION_REPLACED_CODE;

  constructor(sessionName: string) {
    super(
      `Session ${sessionName} was replaced while this send waited for its composer; ` +
        'input lock not acquired, nothing was typed (Issue #3945).'
    );
    this.name = 'InstanceInputSessionReplacedError';
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __instanceInputLocks: Map<string, LockEntry> | undefined;
  // eslint-disable-next-line no-var
  var __instanceInputGeneration:
    | { last: number; lastExclusive?: number; exclusiveEvents?: number; sharedReleases?: number }
    | undefined;
  // eslint-disable-next-line no-var
  var __instanceInputRevoked: WeakSet<InstanceInputTicket> | undefined;
  // eslint-disable-next-line no-var
  var __instanceInputOwnerScope: AsyncLocalStorage<ReadonlyMap<string, InstanceInputTicket>> | undefined;
  // eslint-disable-next-line no-var
  var __instanceInputStartScope: AsyncLocalStorage<InputStartObserver> | undefined;
}

const entries = getOrInitGlobal('__instanceInputLocks', () => new Map<string, LockEntry>());
const generationSeq = getOrInitGlobal('__instanceInputGeneration', () => ({
  last: 0,
  lastExclusive: 0,
  exclusiveEvents: 0,
  sharedReleases: 0,
}));

/**
 * Count an `exclusive` writer coming or going (Issue #3952 review P2-2). The
 * read mark moves on both, so a read taken while a send held the composer is
 * read again once that send has let go, even when no other send came in.
 */
function noteExclusiveEvent(): void {
  generationSeq.exclusiveEvents = (generationSeq.exclusiveEvents ?? 0) + 1;
}

/**
 * Count a `shared` writer letting go (Issue #3975 review P2-1). Only the
 * launch's mark ({@link instanceInputLaunchReadMark}) reads it: an answer that
 * finished between a launch's read and its key may have closed the dialog,
 * while `shared` answers keep their #3952 behaviour toward one another.
 */
function noteSharedRelease(): void {
  generationSeq.sharedReleases = (generationSeq.sharedReleases ?? 0) + 1;
}
/**
 * Tickets revoked by a session replacement (review-2 P1). On `globalThis`, not
 * a field read through `instanceof`: under `next dev` a ticket can be issued by
 * one load of this module (the releasing owner's) and read by another (the
 * waiter's), and a per-load class would not recognise it.
 */
const revokedTickets = getOrInitGlobal('__instanceInputRevoked', () => new WeakSet<InstanceInputTicket>());
const ownerScope = getOrInitGlobal(
  '__instanceInputOwnerScope',
  () => new AsyncLocalStorage<ReadonlyMap<string, InstanceInputTicket>>()
);

function entryOf(sessionName: string): LockEntry {
  let entry = entries.get(sessionName);
  if (entry === undefined) {
    entry = { owner: null, shared: new Set(), queue: [], mark: null };
    entries.set(sessionName, entry);
  }
  return entry;
}

/** Drop an entry that holds nothing, so the map stays bounded by live sessions. */
function pruneEntry(sessionName: string): void {
  const entry = entries.get(sessionName);
  if (entry === undefined) return;
  if (entry.mark !== null && entry.mark.expiresAt <= Date.now()) entry.mark = null;
  if (entry.owner === null && entry.shared.size === 0 && entry.queue.length === 0 && entry.mark === null) {
    entries.delete(sessionName);
  }
}

function issueTicket(sessionName: string, waited: boolean, mode: InstanceInputMode = 'exclusive'): TicketImpl {
  generationSeq.last += 1;
  if (mode === 'exclusive') {
    generationSeq.lastExclusive = generationSeq.last;
    noteExclusiveEvent();
  }
  return new TicketImpl(sessionName, generationSeq.last, waited, mode);
}

/** Whether a writer of `mode` may be admitted now, ahead of nobody. */
function admissible(entry: LockEntry, mode: InstanceInputMode): boolean {
  return entry.owner === null && (mode === 'shared' || entry.shared.size === 0);
}

function grant(entry: LockEntry, ticket: TicketImpl): void {
  if (ticket.mode === 'shared') entry.shared.add(ticket);
  else entry.owner = ticket;
}

/**
 * Admit waiters from the head of the queue, in arrival order: an `exclusive`
 * one once the composer is free, a run of `shared` ones together while no
 * `exclusive` writer owns it. A `shared` waiter behind a queued `exclusive`
 * one is not let past it.
 */
function admitWaiters(sessionName: string, entry: LockEntry): void {
  while (entry.queue.length > 0 && admissible(entry, entry.queue[0].mode)) {
    const next = entry.queue.shift()!;
    clearTimeout(next.timer);
    const nextTicket = issueTicket(sessionName, true, next.mode);
    grant(entry, nextTicket);
    next.admit(nextTicket);
    if (next.mode === 'exclusive') return;
  }
}

function acquire(sessionName: string, waitMs: number, mode: InstanceInputMode = 'exclusive'): Promise<TicketImpl> {
  const entry = entryOf(sessionName);
  if (entry.queue.length === 0 && admissible(entry, mode)) {
    const ticket = issueTicket(sessionName, false, mode);
    grant(entry, ticket);
    return Promise.resolve(ticket);
  }
  return new Promise<TicketImpl>((resolve, reject) => {
    const waiter: Waiter = {
      mode,
      admit: resolve,
      reject,
      timer: setTimeout(() => {
        // Cancelled, not run: the waiter leaves the queue and its function is
        // never called, so it cannot type after the owner it was waiting on.
        const index = entry.queue.indexOf(waiter);
        if (index >= 0) entry.queue.splice(index, 1);
        logger.warn('instance-input-lock-timeout', { sessionName, waitedMs: waitMs, mode });
        // An `exclusive` waiter that gave up may have been all that held the
        // `shared` ones behind it back.
        admitWaiters(sessionName, entry);
        pruneEntry(sessionName);
        reject(new InstanceInputLockTimeoutError(sessionName, waitMs));
      }, waitMs),
    };
    entry.queue.push(waiter);
  });
}

function release(ticket: TicketImpl): void {
  ticket.released = true;
  const entry = entries.get(ticket.sessionName);
  if (entry === undefined) return;
  if (ticket.mode === 'shared') {
    if (!entry.shared.delete(ticket)) return;
    noteSharedRelease();
  } else {
    if (entry.owner !== ticket) return;
    entry.owner = null;
    noteExclusiveEvent();
  }
  admitWaiters(ticket.sessionName, entry);
  pruneEntry(ticket.sessionName);
}

/** The ticket the calling async context already owns for `sessionName`, if any. */
export function currentInstanceInputTicket(sessionName: string): InstanceInputTicket | null {
  const ticket = ownerScope.getStore()?.get(sessionName);
  return ticket !== undefined && ticket.isCurrent() ? ticket : null;
}

/**
 * Run `fn` as the only writer to `sessionName`'s composer.
 *
 * A call from inside a function that already owns the session joins that
 * ownership (same ticket, no second acquisition, released by the outer call).
 * A call from inside an owner whose ticket was revoked (the session was
 * replaced) is refused instead: it belongs to the old request, and acquiring
 * afresh would let that request type into the new session (review-1 #1). A
 * context whose owner simply finished is not an owner any more and acquires as
 * any other caller does.
 *
 * @throws InstanceInputOwnershipLostError when the calling context's ticket was revoked; `fn` did not run
 * @throws InstanceInputLockTimeoutError when not admitted within `waitMs`; `fn` did not run
 * @throws InstanceInputSessionReplacedError when the session was replaced while waiting; `fn` did not run
 */
export async function withInstanceInputLock<T>(
  sessionName: string,
  fn: (ticket: InstanceInputTicket) => Promise<T>,
  options: { waitMs?: number; mode?: InstanceInputMode } = {}
): Promise<T> {
  const inScope = ownerScope.getStore()?.get(sessionName);
  if (inScope !== undefined) {
    if (inScope.isCurrent()) return fn(inScope);
    if (revokedTickets.has(inScope)) {
      logger.warn('instance-input-stale-context-refused', { sessionName, generation: inScope.generation });
      throw new InstanceInputOwnershipLostError(sessionName);
    }
  }

  const ticket = await acquire(sessionName, options.waitMs ?? INSTANCE_INPUT_LOCK_WAIT_MS, options.mode);
  try {
    const scope = new Map(ownerScope.getStore() ?? []);
    scope.set(sessionName, ticket);
    return await ownerScope.run(scope, () => fn(ticket));
  } finally {
    release(ticket);
  }
}

/**
 * Where the order of `exclusive` writers stands now (Issue #3952). An answer
 * takes it right before it reads the screen it will answer, and hands it to
 * {@link answerUnderInstanceInputLock}: a send admitted after it may have typed
 * between that read and the answer's keys. It moves when a send is admitted
 * and when one lets go (review P2-2): a read taken while a send held the
 * composer saw a screen that send was still typing at, and an answer admitted
 * after that send let go — without queueing, and with no other send since —
 * must read it again as well. The count is process-wide, not per session: a
 * send to another session costs a needless re-read, never a missed one.
 */
export function instanceInputReadMark(): number {
  return generationSeq.exclusiveEvents ?? 0;
}

/**
 * The read mark a launch's own key (`mode: 'exclusive'` in
 * {@link answerUnderInstanceInputLock}) is decided on (Issue #3975 review
 * P2-1). It moves as {@link instanceInputReadMark} does and also when a
 * `shared` answer lets go: a `respond` that started and finished between the
 * launch's read and its key never makes the launch wait, yet may have answered
 * the dialog the key was for. Both counts only grow, so their sum moves
 * whenever either does.
 */
export function instanceInputLaunchReadMark(): number {
  return (generationSeq.exclusiveEvents ?? 0) + (generationSeq.sharedReleases ?? 0);
}

/** Why {@link answerUnderInstanceInputLock} typed nothing (Issue #3952). */
export type InstanceInputAnswerSkip =
  /** The screen read again under the lock is not the one the answer was for. */
  | 'target-changed'
  /** The screen could not be read again under the lock. */
  | 'recheck-failed'
  /** Another writer held the composer past the wait. */
  | 'input-lock-timeout'
  /** The session was killed or recreated while the answer waited. */
  | 'session-replaced'
  /** The answer's context, or its ticket, no longer owns the composer. */
  | 'input-lock-lost';

export type InstanceInputAnswerOutcome<T> =
  | { answered: true; value: T }
  | { answered: false; reason: InstanceInputAnswerSkip };

function skipOfLockError(error: unknown): InstanceInputAnswerSkip | null {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === INSTANCE_INPUT_LOCK_TIMEOUT_CODE) return 'input-lock-timeout';
  if (code === INSTANCE_INPUT_SESSION_REPLACED_CODE) return 'session-replaced';
  if (code === INSTANCE_INPUT_OWNERSHIP_LOST_CODE) return 'input-lock-lost';
  return null;
}

/**
 * Type an answer the server decided on its own reading of the screen — a
 * readiness dialog, a prompt answer, a plan-review step — as a `shared` writer
 * (Issue #3952): after any send that holds the composer, and with every send
 * held off until it is done.
 *
 * The screen was read before the lock. When a send was admitted or let go
 * after that read (`readMark`, from {@link instanceInputReadMark}) or the
 * answer had to queue, the screen may have moved under it: `stillApplies` reads it again,
 * and the answer is typed only when it still says yes. A call that joins its
 * context's own ticket (the readiness wait inside a send that holds the lock)
 * held the composer since before its read, so nothing is read again.
 *
 * Never types after a refusal, and never throws for one: a lock that was not
 * admitted in time, a session replaced, a ticket lost, a screen that moved or
 * could not be read all come back as `{ answered: false }`. Errors thrown by
 * `answer` itself propagate.
 *
 * Issue #3975: `mode: 'exclusive'` is for a launch's own keys (gemini's launch
 * line and trust Enter, Claude's trust keys): kept off a send's composer as an
 * answer is, and also ordered against the answers — a `respond` to the same
 * dialog then reads the screen again after the launch's key. The mark is
 * compared before admission there, since the launch's own admission moves it,
 * and `readMark` is {@link instanceInputLaunchReadMark}, so a `shared` answer
 * that finished after the launch's read also makes it read again (review P2-1).
 */
export async function answerUnderInstanceInputLock<T>(
  sessionName: string,
  readMark: number,
  stillApplies: () => Promise<boolean>,
  answer: (ticket: InstanceInputTicket) => Promise<T>,
  options: { waitMs?: number; mode?: InstanceInputMode } = {}
): Promise<InstanceInputAnswerOutcome<T>> {
  // A context that already owns the composer (a send's own readiness wait)
  // has held it since before its read: it joins, and nothing is read again.
  const joined = currentInstanceInputTicket(sessionName) !== null;
  const mode = options.mode ?? 'shared';
  const movedBeforeAdmission =
    (mode === 'exclusive' ? instanceInputLaunchReadMark() : instanceInputReadMark()) !== readMark;
  let admitted = false;
  try {
    return await withInstanceInputLock<InstanceInputAnswerOutcome<T>>(
      sessionName,
      async (ticket) => {
        admitted = true;
        const sendSinceRead =
          !joined &&
          (ticket.waited || movedBeforeAdmission || (mode === 'shared' && instanceInputReadMark() !== readMark));
        if (sendSinceRead) {
          let applies: boolean;
          try {
            applies = await stillApplies();
          } catch (error: unknown) {
            logger.warn('instance-input-answer-recheck-failed', {
              sessionName,
              error: error instanceof Error ? error.message : String(error),
            });
            return { answered: false, reason: 'recheck-failed' };
          }
          if (!applies) {
            logger.info('instance-input-answer-target-changed', { sessionName, generation: ticket.generation });
            return { answered: false, reason: 'target-changed' };
          }
        }
        if (!ticket.isCurrent()) return { answered: false, reason: 'input-lock-lost' };
        return { answered: true, value: await answer(ticket) };
      },
      { waitMs: options.waitMs, mode }
    );
  } catch (error: unknown) {
    // Only the lock's own refusals, before `fn` ran; anything `answer` threw
    // after it was admitted may have typed, and is the caller's to judge.
    const skip = admitted ? null : skipOfLockError(error);
    if (skip === null) throw error;
    logger.warn('instance-input-answer-not-admitted', { sessionName, reason: skip });
    return { answered: false, reason: skip };
  }
}

/**
 * Leave a mark that a body may still arrive in the composer (stage 4).
 *
 * Only the current owner may leave one; a stale ticket's mark is dropped (its
 * send no longer speaks for the composer).
 */
export function leaveCarriedPasteMark(ticket: InstanceInputTicket, now: number = Date.now()): void {
  if (!ticket.isCurrent()) {
    logger.warn('carried-paste-mark-skipped-not-owner', {
      sessionName: ticket.sessionName,
      generation: ticket.generation,
    });
    return;
  }
  const entry = entryOf(ticket.sessionName);
  entry.mark = { originGeneration: ticket.generation, at: now, expiresAt: now + CARRIED_PASTE_MARK_TTL_MS };
  logger.warn('carried-paste-mark-left', {
    sessionName: ticket.sessionName,
    generation: ticket.generation,
    expiresAt: entry.mark.expiresAt,
  });
}

/** The session's unexpired mark, or null. */
export function getCarriedPasteMark(sessionName: string, now: number = Date.now()): CarriedPasteMark | null {
  const mark = entries.get(sessionName)?.mark ?? null;
  return mark !== null && mark.expiresAt > now ? mark : null;
}

/**
 * Take the mark down after waiting it out. Only the current owner may, and only
 * once it has expired: a failed or refused send leaves it in place, with its
 * original expiry.
 */
export function clearExpiredCarriedPasteMark(ticket: InstanceInputTicket, now: number = Date.now()): void {
  if (!ticket.isCurrent()) return;
  const entry = entries.get(ticket.sessionName);
  if (entry?.mark && entry.mark.expiresAt <= now) entry.mark = null;
}

/**
 * Hold the owner off the composer until the session's carried paste mark
 * expires, then take it down (review-1 #5). For writers that cannot read the
 * composer — copilot's own `/model` and selection-list keys; the shared sender
 * reads and withdraws while it waits (`waitOutCarriedPaste`). Returns early when
 * the ticket stops being current; the caller's owner check then refuses.
 *
 * @returns Whether there was a mark to wait out
 */
export async function waitOutCarriedPasteMark(ticket: InstanceInputTicket): Promise<boolean> {
  const mark = getCarriedPasteMark(ticket.sessionName);
  if (mark === null) return false;
  logger.warn('carried-paste-mark-wait', {
    sessionName: ticket.sessionName,
    originGeneration: mark.originGeneration,
    generation: ticket.generation,
    remainingMs: mark.expiresAt - Date.now(),
  });
  while (Date.now() < mark.expiresAt && ticket.isCurrent()) {
    await new Promise((resolve) => setTimeout(resolve, mark.expiresAt - Date.now()));
  }
  clearExpiredCarriedPasteMark(ticket);
  return true;
}

/**
 * The session is being killed or recreated (Issue #3945 review #7): its mark
 * no longer describes the new process's composer, its waiters must not type into
 * the new process, and an owner that is not the caller (a send still in flight
 * against the old pane) loses its ticket.
 *
 * The caller's own ticket survives — that is a send relaunching its own pane
 * (codex's `requireSession({ relaunch: true })`), which goes on to type into the
 * pane it just created.
 */
export function invalidateInstanceInput(sessionName: string): void {
  const entry = entries.get(sessionName);
  if (entry === undefined) return;
  entry.mark = null;
  const own = currentInstanceInputTicket(sessionName);
  if (entry.owner !== null && entry.owner !== own) {
    entry.owner.revoked = true;
    revokedTickets.add(entry.owner);
    entry.owner = null;
    noteExclusiveEvent();
  }
  for (const holder of [...entry.shared]) {
    if (holder === own) continue;
    holder.revoked = true;
    revokedTickets.add(holder);
    entry.shared.delete(holder);
    noteSharedRelease();
  }
  const waiters = entry.queue.splice(0, entry.queue.length);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new InstanceInputSessionReplacedError(sessionName));
  }
  if (waiters.length > 0) logger.info('instance-input-waiters-expired', { sessionName, waiters: waiters.length });
  pruneEntry(sessionName);
}

/** What {@link observeInputStart} hands the sender's context (Issue #3953). */
interface InputStartObserver {
  /** Set by the first {@link noteInputStart} in the context; later calls keep it. */
  at: Date | null;
  /** Run in the same synchronous step as that first call (Issue #3957). */
  onStart?: (at: Date) => void;
}

const inputStartScope = getOrInitGlobal(
  '__instanceInputStartScope',
  () => new AsyncLocalStorage<InputStartObserver>()
);

/**
 * Run `fn` and report when the body it sends started going into the composer
 * (Issue #3953).
 *
 * A send's stamp is what `wait`'s #1975 gate compares with the agent's last
 * `stop`. Read before the input lock, it was older than a previous turn that
 * ended while this send queued for the lock, waited out a carried paste mark,
 * re-read the pane or cleared the composer — and that turn's `stop` read as the
 * end of this one. The sender calls {@link noteInputStart} right before the
 * first key of the body, after all of those, so the stamp is later than any
 * turn that ended before the body and earlier than the `stop` of the turn it
 * starts.
 *
 * @param onStart - Called once, synchronously inside the first
 *   {@link noteInputStart}, so a caller can read state as of the moment the
 *   body started going in (Issue #3957: the send route's open-turn reading). A
 *   throw is logged and does not fail the send.
 * @returns `fn`'s value, and the moment input started — null when nothing in
 *   `fn` noted one (a path that never types a body: opencode's HTTP delivery,
 *   or a send refused before its first key). Never set when `fn` throws.
 */
export async function observeInputStart<T>(
  fn: () => Promise<T>,
  onStart?: (at: Date) => void
): Promise<{ value: T; inputStartedAt: Date | null }> {
  const observer: InputStartObserver = { at: null, onStart };
  const value = await inputStartScope.run(observer, fn);
  return { value, inputStartedAt: observer.at };
}

/**
 * Note that the body is about to be typed or pasted (Issue #3953): the first
 * call in an {@link observeInputStart} context fixes the moment; later ones (a
 * second body, a retry) and calls outside one do nothing.
 */
export function noteInputStart(now: Date = new Date()): void {
  const observer = inputStartScope.getStore();
  if (observer === undefined || observer.at !== null) return;
  observer.at = now;
  try {
    observer.onStart?.(now);
  } catch (error) {
    logger.warn('input-start-observer-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Forget every lock, waiter and mark (tests). */
export function resetInstanceInputLocks(): void {
  for (const entry of entries.values()) {
    for (const waiter of entry.queue) clearTimeout(waiter.timer);
  }
  entries.clear();
}
