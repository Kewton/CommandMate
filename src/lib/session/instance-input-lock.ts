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
 *    instead of queueing behind itself; no lock is ever acquired twice.
 * 4. **The carried paste mark.** A send whose body may still arrive after it
 *    has given up (an `unseen` paste, a read that threw, a clear that could not
 *    be confirmed) leaves a mark. The next owner does not start typing until the
 *    mark expires ({@link CARRIED_PASTE_MARK_TTL_MS}): a placeholder of the same
 *    count as its own body would be indistinguishable from it. The mark belongs
 *    to the session, not to the send that left it, so the next owner is the one
 *    that handles it, and the stale sender cannot resume.
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

/** The owner's handle. */
export interface InstanceInputTicket {
  readonly sessionName: string;
  /** Never reused, across sessions and module reloads. */
  readonly generation: number;
  /**
   * Whether the owner had to queue for the composer. A writer that did not was
   * admitted the moment it asked, so what it read before asking is as fresh as
   * it was before this module existed; one that queued may be acting on a
   * screen that changed behind another writer (#3945 stage 2).
   */
  readonly waited: boolean;
  /** True while this ticket still owns the session's composer. */
  isCurrent(): boolean;
}

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
  admit: (ticket: TicketImpl) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LockEntry {
  owner: TicketImpl | null;
  queue: Waiter[];
  mark: CarriedPasteMark | null;
}

class TicketImpl implements InstanceInputTicket {
  released = false;
  revoked = false;

  constructor(
    readonly sessionName: string,
    readonly generation: number,
    readonly waited: boolean
  ) {}

  isCurrent(): boolean {
    return !this.released && !this.revoked && entries.get(this.sessionName)?.owner === this;
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
  var __instanceInputGeneration: { last: number } | undefined;
  // eslint-disable-next-line no-var
  var __instanceInputOwnerScope: AsyncLocalStorage<ReadonlyMap<string, InstanceInputTicket>> | undefined;
}

const entries = getOrInitGlobal('__instanceInputLocks', () => new Map<string, LockEntry>());
const generationSeq = getOrInitGlobal('__instanceInputGeneration', () => ({ last: 0 }));
const ownerScope = getOrInitGlobal(
  '__instanceInputOwnerScope',
  () => new AsyncLocalStorage<ReadonlyMap<string, InstanceInputTicket>>()
);

function entryOf(sessionName: string): LockEntry {
  let entry = entries.get(sessionName);
  if (entry === undefined) {
    entry = { owner: null, queue: [], mark: null };
    entries.set(sessionName, entry);
  }
  return entry;
}

/** Drop an entry that holds nothing, so the map stays bounded by live sessions. */
function pruneEntry(sessionName: string): void {
  const entry = entries.get(sessionName);
  if (entry === undefined) return;
  if (entry.mark !== null && entry.mark.expiresAt <= Date.now()) entry.mark = null;
  if (entry.owner === null && entry.queue.length === 0 && entry.mark === null) entries.delete(sessionName);
}

function issueTicket(sessionName: string, waited: boolean): TicketImpl {
  generationSeq.last += 1;
  return new TicketImpl(sessionName, generationSeq.last, waited);
}

function acquire(sessionName: string, waitMs: number): Promise<TicketImpl> {
  const entry = entryOf(sessionName);
  if (entry.owner === null && entry.queue.length === 0) {
    const ticket = issueTicket(sessionName, false);
    entry.owner = ticket;
    return Promise.resolve(ticket);
  }
  return new Promise<TicketImpl>((resolve, reject) => {
    const waiter: Waiter = {
      admit: resolve,
      reject,
      timer: setTimeout(() => {
        // Cancelled, not run: the waiter leaves the queue and its function is
        // never called, so it cannot type after the owner it was waiting on.
        const index = entry.queue.indexOf(waiter);
        if (index >= 0) entry.queue.splice(index, 1);
        logger.warn('instance-input-lock-timeout', { sessionName, waitedMs: waitMs });
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
  if (entry === undefined || entry.owner !== ticket) return;
  entry.owner = null;
  const next = entry.queue.shift();
  if (next !== undefined) {
    clearTimeout(next.timer);
    const nextTicket = issueTicket(ticket.sessionName, true);
    entry.owner = nextTicket;
    next.admit(nextTicket);
    return;
  }
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
 *
 * @throws InstanceInputLockTimeoutError when not admitted within `waitMs`; `fn` did not run
 * @throws InstanceInputSessionReplacedError when the session was replaced while waiting; `fn` did not run
 */
export async function withInstanceInputLock<T>(
  sessionName: string,
  fn: (ticket: InstanceInputTicket) => Promise<T>,
  options: { waitMs?: number } = {}
): Promise<T> {
  const held = currentInstanceInputTicket(sessionName);
  if (held !== null) return fn(held);

  const ticket = await acquire(sessionName, options.waitMs ?? INSTANCE_INPUT_LOCK_WAIT_MS);
  try {
    const scope = new Map(ownerScope.getStore() ?? []);
    scope.set(sessionName, ticket);
    return await ownerScope.run(scope, () => fn(ticket));
  } finally {
    release(ticket);
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
    entry.owner = null;
  }
  const waiters = entry.queue.splice(0, entry.queue.length);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new InstanceInputSessionReplacedError(sessionName));
  }
  if (waiters.length > 0) logger.info('instance-input-waiters-expired', { sessionName, waiters: waiters.length });
  pruneEntry(sessionName);
}

/** Forget every lock, waiter and mark (tests). */
export function resetInstanceInputLocks(): void {
  for (const entry of entries.values()) {
    for (const waiter of entry.queue) clearTimeout(waiter.timer);
  }
  entries.clear();
}
