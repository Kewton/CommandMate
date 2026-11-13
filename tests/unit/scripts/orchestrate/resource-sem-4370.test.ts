/**
 * resource-sem.mjs: the machine semaphore's pure decisions (Issue #4370 PR1a,
 * docs/design/resource-4370.md §9.2 — rows C01〜C08・G03・G04・O1〜O3・GT1〜GT5・AD1・AD2・R1〜R6・W1).
 *
 * No file, lock or process: every observation is passed in. The positive controls of the table were
 * checked once against naive variants (recorded in the commit body), not kept as switches here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  HOLDER_NAME_PATTERN,
  WAITER_NAME_PATTERN,
  admissible,
  effectiveCapacity,
  gateNext,
  holderRetirable,
  isParticipantName,
  orderWaiters,
  waiterRetirable,
} from '../../../../scripts/orchestrate/resource-sem.mjs';

const HOST = 'host-a';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

const holder = (token: string, o: Record<string, unknown> = {}) => ({
  name: `${token}.json`,
  record: { v: 1, token, pid: 500, host: HOST, pgid: 500, leaderStart: 1_000, createdAt: 1_000, priority: 'P2', weight: 1, ownCapacity: 3, admittedCapacity: 3, ...o },
});
const waiterName = (p: number, n: number) => `${p}-${String(n).padStart(12, '0')}.json`;
const waiter = (p: number, n: number, o: Record<string, unknown> = {}) => ({
  name: waiterName(p, n),
  record: { v: 1, token: `w-${p}-${n}`, pid: 600 + n, host: HOST, createdAt: 1_000, deadline: 10_000, priority: `P${p}`, weight: 1, ownCapacity: 3, ...o },
});

describe('names: only a published name is a participant (prereview 3 H1)', () => {
  it('holders are <uuid>.json and waiters <P>-<12 digits>.json; a tmp is neither', () => {
    expect(HOLDER_NAME_PATTERN.test(`${T1}.json`)).toBe(true);
    expect(WAITER_NAME_PATTERN.test(waiterName(2, 7))).toBe(true);
    expect(isParticipantName('holders', `.tmp-${T1}`)).toBe(false);
    expect(isParticipantName('waiters', `.tmp-w-2-7`)).toBe(false);
    expect(isParticipantName('waiters', '4-000000000001.json')).toBe(false);
  });
});

describe('effectiveCapacity + admissible: the C01〜C08 rows', () => {
  it('C01: a smaller ownCapacity published just now counts at once — a (P0, w2) is not admitted', () => {
    const participants = [holder(T1, { ownCapacity: 3, weight: 1 }), waiter(2, 2, { ownCapacity: 2 })];
    const c = effectiveCapacity({ own: 3, participants });
    expect(c).toEqual({ state: 'ok', capacity: 2 });
    expect(admissible({ capacity: 2, holders: [participants[0]], waiter: { priority: 'P0', weight: 2 }, gate: 'open' })).toBe(false);
  });

  it('C02: state.json missing or broken, gate closed, a is P0 — still C=2 and not admitted (the copy is no input)', () => {
    const participants = [holder(T1, { ownCapacity: 3, weight: 1 }), waiter(2, 2, { ownCapacity: 2 })];
    const c = effectiveCapacity({ own: 3, participants, complete: true });
    expect(c).toEqual({ state: 'ok', capacity: 2 });
    expect(admissible({ capacity: 2, holders: [participants[0]], waiter: { priority: 'P0', weight: 2 }, gate: 'closed' })).toBe(false);
  });

  it('C03 (negative): everyone at 3, or nobody with a complete listing — C=3 and 1+2 ≤ 3 is admitted', () => {
    const h = holder(T1, { ownCapacity: 3, weight: 1 });
    expect(effectiveCapacity({ own: 3, participants: [h, waiter(1, 1)] })).toEqual({ state: 'ok', capacity: 3 });
    expect(effectiveCapacity({ own: 3, participants: [], complete: true })).toEqual({ state: 'ok', capacity: 3 });
    expect(admissible({ capacity: 3, holders: [h], waiter: { priority: 'P0', weight: 2 }, gate: 'open' })).toBe(true);
  });

  it('C04: after a shrink (held 3 > C=2) nobody is admitted; once the sum is 1, w1 is', () => {
    const held = [holder(T1, { weight: 2 }), holder(T2, { weight: 1 })];
    expect(admissible({ capacity: 2, holders: held, waiter: { priority: 'P0', weight: 1 }, gate: 'open' })).toBe(false);
    expect(admissible({ capacity: 2, holders: [holder(T2, { weight: 1 })], waiter: { priority: 'P0', weight: 1 }, gate: 'open' })).toBe(true);
  });

  it('C05: a weight 3 before publishing against a minimum own of 2 — C=2, the material to refuse (I10)', () => {
    const c = effectiveCapacity({ own: 5, participants: [waiter(2, 1, { ownCapacity: 2 })] });
    expect(c).toEqual({ state: 'ok', capacity: 2 });
    expect(c.state === 'ok' && 3 > c.capacity).toBe(true);
  });

  it('C06: the small participant left; a holder admitted at 2 with own 3 remains — C rises to 3', () => {
    expect(effectiveCapacity({ own: 3, participants: [holder(T1, { ownCapacity: 3, admittedCapacity: 2 })] })).toEqual({ state: 'ok', capacity: 3 });
  });

  it('C07: an incomplete listing or an unreadable ownCapacity is unknown; an unknown liveness does not move C', () => {
    expect(effectiveCapacity({ own: 3, participants: [], complete: false })).toEqual({ state: 'unknown', point: 'list' });
    expect(effectiveCapacity({ own: 3, participants: [waiter(2, 1, { ownCapacity: null })] })).toMatchObject({ state: 'unknown', point: 'ownCapacity' });
    expect(effectiveCapacity({ own: 3, participants: [{ name: `${T1}.json`, record: null }] })).toMatchObject({ state: 'unknown', point: 'ownCapacity', name: `${T1}.json` });
    expect(effectiveCapacity({ own: 3, participants: [waiter(2, 1, { ownCapacity: '2' })] }).state).toBe('unknown');
    // A holder whose group could not be observed is passed as a participant like a live one.
    expect(effectiveCapacity({ own: 3, participants: [holder(T1, { ownCapacity: 3 })] })).toEqual({ state: 'ok', capacity: 3 });
  });

  it('C08: the minimum of {3, 2, 4} and own 5 is 2', () => {
    const participants = [holder(T1, { ownCapacity: 3 }), holder(T2, { ownCapacity: 2 }), waiter(1, 1, { ownCapacity: 4 })];
    expect(effectiveCapacity({ own: 5, participants })).toEqual({ state: 'ok', capacity: 2 });
  });
});

describe('orderWaiters + admissible: G03・G04', () => {
  it('G03 (negative): C=1, a P2 w1 runs; waiters P2(1)・P0(2) — the head is P0 and not admitted (no pre-emption); when the holder leaves, P0 is', () => {
    const running = [holder(T1, { priority: 'P2', weight: 1, ownCapacity: 1 })];
    const order = orderWaiters({ waiters: [waiter(2, 1), waiter(0, 2)], holders: running });
    expect(order.map((w) => w.name)).toEqual([waiterName(0, 2), waiterName(2, 1)]);
    expect(admissible({ capacity: 1, holders: running, waiter: { priority: 'P0', weight: 1 }, gate: 'open' })).toBe(false);
    expect(admissible({ capacity: 1, holders: [], waiter: { priority: 'P0', weight: 1 }, gate: 'open' })).toBe(true);
  });

  it('G04: C=1, nothing held, a P2 w1 with the gate open is admitted (no P0 reservation)', () => {
    expect(admissible({ capacity: 1, holders: [], waiter: { priority: 'P2', weight: 1 }, gate: 'open' })).toBe(true);
  });
});

describe('orderWaiters: O1〜O3', () => {
  it('O1: priority first, then the number', () => {
    const order = orderWaiters({ waiters: [waiter(3, 1), waiter(2, 2), waiter(0, 3), waiter(2, 4)], holders: [] });
    expect(order.map((w) => `${w.priority}(${w.n})`)).toEqual(['P0(3)', 'P2(2)', 'P2(4)', 'P3(1)']);
  });

  it('O2: a waiter whose token already has a holder record is dropped (admitted, not yet marked used)', () => {
    const x = waiter(0, 1, { token: T3 });
    const y = waiter(1, 2);
    const order = orderWaiters({ waiters: [x, y], holders: [holder(T3)] });
    expect(order.map((w) => w.name)).toEqual([y.name]);
  });

  it('O3: a used waiter (done) is dropped; an unreadable one stays in place as corrupt', () => {
    const used = { name: waiterName(0, 1), record: { done: true, token: 'w-0-1', doneAt: 5 } };
    const broken = { name: waiterName(1, 2), record: null };
    const order = orderWaiters({ waiters: [used, broken, waiter(2, 3)], holders: [] });
    expect(order.map((w) => [w.name, w.corrupt])).toEqual([[waiterName(1, 2), true], [waiterName(2, 3), false]]);
  });
});

describe('gateNext: GT1〜GT5', () => {
  const base = { ncpu: 10, ceiling: 1.0, resume: 0.85 };

  it('GT1: open at load1 = ceiling × ncpu closes', () => {
    expect(gateNext({ ...base, prev: 'open', load1: 10 })).toBe('closed');
  });

  it('GT2: hysteresis — open stays at 0.9, closed stays at 0.9 and at exactly resume', () => {
    expect(gateNext({ ...base, prev: 'open', load1: 9 })).toBe('open');
    expect(gateNext({ ...base, prev: 'closed', load1: 9 })).toBe('closed');
    expect(gateNext({ ...base, prev: 'closed', load1: 8.5 })).toBe('closed');
  });

  it('GT3: closed below resume opens', () => {
    expect(gateNext({ ...base, prev: 'closed', load1: 8 })).toBe('open');
  });

  it('GT4: a prev that could not be read is closed, whatever the load (§4.2)', () => {
    expect(gateNext({ ...base, prev: null, load1: 0.1 })).toBe('closed');
    expect(gateNext({ ...base, prev: null, load1: 9 })).toBe('closed');
    expect(gateNext({ ...base, prev: 'garbage', load1: 9.5 })).toBe('closed');
    expect(gateNext({ ...base, prev: undefined, load: [9, 9, 9] })).toBe('closed');
  });

  it('GT5 (negative): load [0,0,0] (Windows) is open, whatever prev was', () => {
    expect(gateNext({ ...base, prev: null, load: [0, 0, 0] })).toBe('open');
    expect(gateNext({ ...base, prev: 'closed', load: [0, 0, 0] })).toBe('open');
  });
});

describe('admissible: AD1・AD2', () => {
  it.each([
    ['P2', false],
    ['P3', false],
    ['P0', true],
    ['P1', true],
  ])('AD1: the gate closed — %s → %s', (priority, expected) => {
    expect(admissible({ capacity: 4, holders: [], waiter: { priority, weight: 1 }, gate: 'closed' })).toBe(expected);
  });

  it('AD2: an unreadable holder occupies the whole capacity', () => {
    expect(admissible({ capacity: 4, holders: [{ name: `${T1}.json`, record: null }], waiter: { priority: 'P0', weight: 1 }, gate: 'open' })).toBe(false);
  });

  it('refuses a bad weight or priority rather than admitting', () => {
    expect(admissible({ capacity: 4, holders: [], waiter: { priority: 'P0', weight: 0 }, gate: 'open' })).toBe(false);
    expect(admissible({ capacity: 4, holders: [], waiter: { priority: 'P9', weight: 1 }, gate: 'open' })).toBe(false);
  });
});

describe('holderRetirable: R1〜R6', () => {
  const rec = holder(T1, { pid: 700, pgid: 500, leaderStart: 1_000 }).record;
  const env = (o: Partial<{ group: boolean | 'alive' | 'gone' | 'unknown'; pid: boolean; startOfPgid: number | null; startOfPid: number | null; host: string }>) => ({
    host: o.host ?? HOST,
    now: 5_000,
    pidAlive: () => o.pid ?? true,
    groupAlive: () => o.group ?? 'alive',
    startOf: (pid: number) => (pid === 500 ? (o.startOfPgid === undefined ? 1_000 : o.startOfPgid) : (o.startOfPid ?? 1_000)),
  });

  it('R1: the group is empty (ESRCH)', () => {
    expect(holderRetirable(rec, env({ group: 'gone' }))).toBe('group-gone');
    expect(holderRetirable(rec, env({ group: false }))).toBe('group-gone');
  });

  it('R2: the pid is dead but the group lives — kept', () => {
    // The pid's own death is no evidence while the group lives: only the group and its leader's start are.
    expect(holderRetirable(rec, env({ group: 'alive', pid: false }))).toBeNull();
  });

  it('R3: the pid started later (reused) while the group and its leader are the recorded ones — kept', () => {
    expect(holderRetirable(rec, env({ group: 'alive', startOfPid: 99_999 }))).toBeNull();
  });

  it('R4: the group lives but its leader started after leaderStart + slack — the number was reused', () => {
    expect(holderRetirable(rec, env({ group: 'alive', startOfPgid: 1_000 + 2_001 }))).toBe('leader-reused');
    expect(holderRetirable(rec, env({ group: 'alive', startOfPgid: 1_000 + 2_000 }))).toBeNull();
  });

  it('R5: the group cannot be observed (EPERM), or leaderStart is null with the group alive — kept', () => {
    expect(holderRetirable(rec, env({ group: 'unknown' }))).toBeNull();
    expect(holderRetirable({ ...rec, leaderStart: null }, env({ group: 'alive', startOfPgid: 99_999 }))).toBeNull();
    expect(holderRetirable(rec, env({ group: 'alive', startOfPgid: null }))).toBeNull();
  });

  it('R6 (negative): another host is never reclaimed here; nor an unreadable record', () => {
    expect(holderRetirable(rec, env({ host: 'host-b', group: 'gone' }))).toBeNull();
    expect(holderRetirable(null, env({ group: 'gone' }))).toBeNull();
  });
});

describe('waiterRetirable: W1 (the machine-lock ticket rule as is)', () => {
  const rec = waiter(2, 1, { pid: 800, createdAt: 1_000, deadline: 10_000 }).record;
  const env = (o: Partial<{ pid: boolean; start: number | null; now: number; host: string }>) => ({
    host: o.host ?? HOST,
    now: o.now ?? 5_000,
    pidAlive: () => o.pid ?? true,
    groupAlive: () => true,
    startOf: () => (o.start === undefined ? 1_000 : o.start),
  });

  it.each([
    ['gone', env({ pid: false }), 'gone'],
    ['pid-reused', env({ start: 1_000 + 2_001 }), 'pid-reused'],
    ['expired', env({ now: 10_000 + 60_001 }), 'expired'],
  ])('%s', (_label, e, expected) => {
    expect(waiterRetirable(rec, e)).toBe(expected);
  });

  it('another host within its grace is kept', () => {
    expect(waiterRetirable({ ...rec, host: 'host-b' }, env({ now: 10_000 + 60_001 }))).toBeNull();
  });
});
