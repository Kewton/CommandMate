/**
 * The machine semaphore's decisions, as pure functions (Issue #4370 PR1a, docs/design/resource-4370.md
 * §2.3.1・§2.4・§2.5).
 *
 * Nothing here writes a file, takes a lock or starts a process: the observations (`kill -0`, `ps`, the
 * listing) are made by the caller and passed in. PR1a's caller is `resource.mjs status` (read only);
 * PR1b's admission will call the same functions inside the `cpu.sem.admit` lock.
 *
 * Records live under `<root>/cpu.sem/`:
 *
 *   holders/<token>.json      one holder (token = a UUID)       HOLDER_NAME_PATTERN
 *   waiters/<P>-<12 digits>.json  one waiter (P = 0..3)          WAITER_NAME_PATTERN
 *
 * Only a name that matches its pattern is a published participant (prereview 3, H1). A tmp being
 * written, or one a writer left when it died (names starting with `.`), is not a participant and not a
 * corrupt record; neither is a record that vanished between the listing and the read (ENOENT: it left).
 * A published record that cannot be parsed, or lacks `ownCapacity`, makes the capacity unknown (U1).
 *
 * An entry is `{ name, record }`, with `record` null when a published record could not be read.
 */
import { PID_REUSE_SLACK_MS, ticketRetirable } from './machine-lock-sync.mjs';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
/** A holder's file: `<token>.json`, the token a UUID. */
export const HOLDER_NAME_PATTERN = /^[0-9a-f-]{36}\.json$/;
/** A waiter's file: `<P>-<12 digits>.json`, P the priority's digit — lexical order is (priority, number). */
export const WAITER_NAME_PATTERN = /^([0-3])-(\d{12})\.json$/;

const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether `name` is a published participant's file of `kind` ('holders' | 'waiters'). */
export function isParticipantName(kind, name) {
  return (kind === 'holders' ? HOLDER_NAME_PATTERN : WAITER_NAME_PATTERN).test(name);
}

/** A waiter file's priority digit and number, or null for a name outside the pattern. */
export function parseWaiterName(name) {
  const m = WAITER_NAME_PATTERN.exec(name);
  return m ? { priority: Number(m[1]), n: Number(m[2]) } : null;
}

/**
 * The effective C (§2.3.1): the minimum of `own` and every participant's `ownCapacity`, over the
 * participants listed in the same critical section (live, not `done`, after reclaim). Neither a holder's
 * `admittedCapacity` nor `state.json`'s copy is an input. One participant whose `ownCapacity` cannot be
 * read, or an incomplete listing, is `unknown` — never replaced with `own`.
 *
 * @param {{ own: number, participants: { name?: string, record: any }[], complete?: boolean }} input
 * @returns {{ state: 'ok', capacity: number } | { state: 'unknown', point: string, name?: string }}
 */
export function effectiveCapacity({ own, participants, complete = true }) {
  if (complete !== true || !Array.isArray(participants)) return { state: 'unknown', point: 'list' };
  if (!isPositiveInt(own)) return { state: 'unknown', point: 'own' };
  let capacity = own;
  for (const entry of participants) {
    const value = isRecord(entry?.record) ? entry.record.ownCapacity : undefined;
    if (!isPositiveInt(value)) return { state: 'unknown', point: 'ownCapacity', ...(entry?.name ? { name: entry.name } : {}) };
    capacity = Math.min(capacity, value);
  }
  return { state: 'ok', capacity };
}

/**
 * The weight the holders occupy: each live or unobservable holder's `weight`; a holder whose record is
 * unreadable (or whose weight is not an integer ≥ 1) occupies the whole `capacity`.
 *
 * @param {{ capacity: number, holders: { name?: string, record: any }[] }} input
 */
export function heldWeight({ capacity, holders }) {
  let sum = 0;
  for (const entry of holders) {
    const weight = isRecord(entry?.record) ? entry.record.weight : undefined;
    sum += isPositiveInt(weight) ? weight : capacity;
  }
  return sum;
}

/**
 * Whether `waiter` may be admitted now (§2.3.1): `Σ holders' weight + waiter.weight ≤ capacity`, and the
 * gate is open or the waiter is P0 / P1. After a shrink (the sum above C) nobody is admitted until it
 * drains. Callers pass only the head (I3); the reservation for P0 is not taken (§6.2).
 *
 * @param {{ capacity: number, holders: { name?: string, record: any }[], waiter: { priority: string, weight: number }, gate: 'open' | 'closed' }} input
 */
export function admissible({ capacity, holders, waiter, gate }) {
  if (!isPositiveInt(capacity) || !Array.isArray(holders) || !waiter) return false;
  if (!isPositiveInt(waiter.weight) || !PRIORITIES.includes(waiter.priority)) return false;
  if (gate !== 'open' && waiter.priority !== 'P0' && waiter.priority !== 'P1') return false;
  return heldWeight({ capacity, holders }) + waiter.weight <= capacity;
}

/**
 * The load gate with hysteresis (§2.4): open closes at `load1 ≥ ceiling × ncpu`; closed opens below
 * `resume × ceiling × ncpu`; otherwise it stays. A `prev` that could not be read is closed, whatever the
 * load (§4.2). A load of
 * all zeros (`[0,0,0]`, what Windows answers) is open — the ledger still counts.
 *
 * @param {{ prev: any, load1?: number, load?: number[], ncpu: number, ceiling: number, resume: number }} input
 * @returns {'open' | 'closed'}
 */
export function gateNext({ prev, load1, load, ncpu, ceiling, resume }) {
  const value = Array.isArray(load) ? load[0] : load1;
  const allZero = Array.isArray(load) ? load.length > 0 && load.every((v) => v === 0) : value === 0;
  if (allZero) return 'open';
  // §4.2: an unreadable prev is closed whatever the load; the next admission writes it back and the
  // round after that applies the hysteresis to a readable `closed`.
  if (prev !== 'open' && prev !== 'closed') return 'closed';
  const state = prev;
  if (typeof value !== 'number' || !Number.isFinite(value)) return state;
  const close = ceiling * ncpu;
  if (state === 'open') return value >= close ? 'closed' : 'open';
  return value < resume * close ? 'open' : 'closed';
}

/**
 * The waiters in admission order (§2.3 step 3-3・3-6): drop the used ones (`done`) and those whose
 * token already has a holder record (admitted, the waiter not yet marked used), then sort by
 * (priority, number) taken from the file name. An unreadable waiter stays in place (it blocks like a
 * live one) with `corrupt: true`.
 *
 * @param {{ waiters: { name: string, record: any }[], holders: { name?: string, record: any }[] }} input
 * @returns {{ name: string, record: any, priority: string, n: number, corrupt: boolean }[]}
 */
export function orderWaiters({ waiters, holders }) {
  const held = new Set();
  for (const entry of holders) if (isRecord(entry?.record) && typeof entry.record.token === 'string') held.add(entry.record.token);
  const out = [];
  for (const entry of waiters) {
    const parsed = parseWaiterName(entry.name);
    if (!parsed) continue;
    const record = entry.record;
    if (isRecord(record) && record.done === true) continue;
    if (isRecord(record) && typeof record.token === 'string' && held.has(record.token)) continue;
    out.push({ name: entry.name, record, priority: PRIORITIES[parsed.priority], n: parsed.n, corrupt: !isRecord(record) });
  }
  return out.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.n - b.n);
}

/** An observation of a group in three values; a boolean is read as alive / gone. */
const groupState = (answer) => {
  if (answer === true || answer === 'alive') return 'alive';
  if (answer === false || answer === 'gone') return 'gone';
  return 'unknown';
};

/**
 * Why a holder's record may be reclaimed, or null (§2.5). The holder is seen as its process group:
 * only an empty group (ESRCH), or the group's number reused by a new leader (the process `pgid` started
 * after `leaderStart` + slack), retires it. The pid's own death or reuse never does while the group
 * lives; an unknown observation, `leaderStart: null`, another host or an unreadable record never do.
 *
 * @param {any} record
 * @param {{ host: string, groupAlive: (pgid: number) => boolean | 'alive' | 'gone' | 'unknown', startOf: (pid: number) => number | null }} env
 * @returns {'group-gone' | 'leader-reused' | null}
 */
export function holderRetirable(record, env) {
  if (!isRecord(record) || record.host !== env.host) return null;
  if (!Number.isInteger(record.pgid) || record.pgid <= 1) return null;
  const group = groupState(env.groupAlive(record.pgid));
  if (group === 'gone') return 'group-gone';
  if (group !== 'alive' || typeof record.leaderStart !== 'number') return null;
  const start = env.startOf(record.pgid);
  return typeof start === 'number' && start > record.leaderStart + PID_REUSE_SLACK_MS ? 'leader-reused' : null;
}

/**
 * Why a waiter's record may be retired, or null — the machine-lock ticket's rule as is
 * (`ticketRetirable`: gone / pid-reused / expired, another host after its longer grace).
 *
 * @param {any} record
 * @param {{ host: string, now: number, pidAlive: (pid: number) => boolean, groupAlive: (pgid: number) => boolean, startOf: (pid: number) => number | null }} env
 */
export function waiterRetirable(record, env) {
  return ticketRetirable(record, env);
}
