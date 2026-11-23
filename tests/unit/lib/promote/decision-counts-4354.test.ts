/**
 * The counts of a branch's decisions with the breakdown of Issue #4354 (design
 * `docs/design/mem-approval-4354.md` §4.1, §5 the counts row).
 *
 * - The fields of #4355 (`open`, `recorded`, `approvable`) keep their meaning and type: without
 *   the clock the answer is exactly #4355's; with it, the same values plus the new fields.
 * - Every `open` decision is in exactly one of `pending` / `grants` / `expiredGrants` /
 *   `noDestination` (N3), on every row of the table.
 * - What ended in the last 24 hours is counted from the closed rows and the clock only.
 *
 * Pure: no database, no clock but the one given.
 */
import { describe, expect, it } from 'vitest';
import {
  DECISION_RECENT_WINDOW_MS,
  decisionCountsOf,
  type DecisionCountsDetail,
  type DecisionCountsItem,
  type DecisionCountsMode,
} from '@/lib/promote/decision-counts';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const at = (epochMs: number, expires?: true) => JSON.stringify({ schema: 1, type: 'at', epochMs, offset: '+09:00', ...(expires ? { expires } : {}) });
const decision = (fields: Partial<DecisionCountsItem>): DecisionCountsItem => ({ kind: 'decision', state: 'open', promoteTo: null, closeWhen: null, closedAt: null, closeReason: null, ...fields });

/** One row per kind of open decision the breakdown tells apart (design §5). */
const OPEN_ROWS: Array<[string, DecisionCountsItem, keyof DecisionCountsDetail]> = [
  ['with a destination, no condition', decision({ promoteTo: 'issue:#1' }), 'pending'],
  ['with a destination and a marked expiry passed', decision({ promoteTo: 'path:docs/d.md', closeWhen: at(NOW - HOUR, true) }), 'pending'],
  ['withheld (the destination not shown)', { kind: 'decision', state: 'open' }, 'pending'],
  ['no destination, a marked expiry ahead', decision({ closeWhen: at(NOW + HOUR, true) }), 'grants'],
  ['no destination, a marked expiry passed', decision({ closeWhen: at(NOW - HOUR, true) }), 'expiredGrants'],
  ['no destination, a marked expiry exactly now', decision({ closeWhen: at(NOW, true) }), 'expiredGrants'],
  ['no destination, as shown (the condition read)', decision({ closeWhen: { schema: 1, type: 'at', epochMs: NOW + HOUR, offset: 'Z', expires: true } as never }), 'grants'],
  ['no destination, no condition', decision({}), 'noDestination'],
  ['no destination, an unmarked at passed', decision({ closeWhen: at(NOW - HOUR) }), 'noDestination'],
  ['no destination, an issue condition', decision({ closeWhen: JSON.stringify({ schema: 1, type: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1, state: 'closed' }) }), 'noDestination'],
  ['no destination, a pr condition', decision({ closeWhen: JSON.stringify({ schema: 1, type: 'pr', host: 'github.com', owner: 'o', repo: 'r', number: 1, state: 'merged' }) }), 'noDestination'],
  ['no destination, a branch condition', decision({ closeWhen: JSON.stringify({ schema: 1, type: 'branch', state: 'merged' }) }), 'noDestination'],
  ['no destination, an unreadable condition', decision({ closeWhen: '{not json' }), 'noDestination'],
];

const BREAKDOWN = ['pending', 'grants', 'expiredGrants', 'noDestination'] as const;
const sumOf = (counts: DecisionCountsDetail) => BREAKDOWN.reduce((sum, key) => sum + (counts[key] as number), 0);

describe('#4355 I6 unchanged: without the clock the answer is the one it was', () => {
  it.each(['on', 'off', 'derived'] as const)('mode %s: exactly { mode, approvable, open, recorded }', (mode) => {
    const counts = decisionCountsOf(mode, [decision({}), decision({ state: 'recorded' }), decision({ state: 'promoted' }), { kind: 'note', state: 'open' }]);
    expect(counts).toEqual({ mode, approvable: mode === 'on', open: 1, recorded: 1 });
  });

  it('with the clock, the #4355 fields answer the same values', () => {
    const items = OPEN_ROWS.map(([, item]) => item).concat([decision({ state: 'recorded' }), decision({ state: 'promoted' })]);
    const before = decisionCountsOf('on', items);
    const after = decisionCountsOf('on', items, NOW);
    expect({ mode: after.mode, approvable: after.approvable, open: after.open, recorded: after.recorded }).toEqual(before);
  });
});

describe('§4.1: every open decision is in exactly one field (N3)', () => {
  it.each(OPEN_ROWS)('%s → %s', (_name, item, field) => {
    const counts = decisionCountsOf('on', [item], NOW);
    expect(counts.open).toBe(1);
    expect(counts[field]).toBe(1);
    expect(sumOf(counts)).toBe(counts.open);
  });

  it.each(['on', 'off', 'derived'] as const)('mode %s: all the rows together sum to open', (mode) => {
    const counts = decisionCountsOf(mode, OPEN_ROWS.map(([, item]) => item), NOW);
    expect(counts.open).toBe(OPEN_ROWS.length);
    expect(sumOf(counts)).toBe(OPEN_ROWS.length);
    expect(counts).toMatchObject({ pending: 3, grants: 2, expiredGrants: 2, noDestination: 6 });
  });

  it('a grant moves from grants to expiredGrants when the clock passes its expiry (time only)', () => {
    const grant = decision({ closeWhen: at(NOW + HOUR, true) });
    expect(decisionCountsOf('on', [grant], NOW)).toMatchObject({ grants: 1, expiredGrants: 0 });
    expect(decisionCountsOf('on', [grant], NOW + HOUR)).toMatchObject({ grants: 0, expiredGrants: 1 });
  });

  it('recorded / promoted are in none of the four (recorded keeps its own field)', () => {
    const counts = decisionCountsOf('on', [decision({ state: 'recorded', promoteTo: 'issue:#1' }), decision({ state: 'promoted', promoteTo: 'issue:#1' })], NOW);
    expect(counts).toMatchObject({ open: 0, recorded: 1, pending: 0, grants: 0, expiredGrants: 0, noDestination: 0 });
  });
});

describe('§4.1: what ended in the last 24 hours', () => {
  const closed = (fields: Partial<DecisionCountsItem>, agoMs: number) => decision({ state: 'closed', closedAt: NOW - agoMs, ...fields });

  it.each([
    ['a grant closed by its expiry, 1 hour ago', closed({ closeWhen: at(NOW - 2 * HOUR, true), closeReason: 'condition' }, HOUR), { endedGrants: 1, withdrawnDecisions: 0 }],
    ['a grant withdrawn, 1 hour ago', closed({ closeWhen: at(NOW + HOUR, true), closeReason: 'withdrawn' }, HOUR), { endedGrants: 1, withdrawnDecisions: 0 }],
    ['a decision withdrawn, 1 hour ago', closed({ promoteTo: 'issue:#1', closeReason: 'withdrawn' }, HOUR), { endedGrants: 0, withdrawnDecisions: 1 }],
    ['a decision with no destination withdrawn, 1 hour ago', closed({ closeReason: 'withdrawn' }, HOUR), { endedGrants: 0, withdrawnDecisions: 1 }],
    ['a decision closed by hand, 1 hour ago', closed({ promoteTo: 'issue:#1', closeReason: 'manual' }, HOUR), { endedGrants: 0, withdrawnDecisions: 0 }],
    ['a decision withdrawn exactly 24 hours ago', closed({ closeReason: 'withdrawn' }, DECISION_RECENT_WINDOW_MS), { endedGrants: 0, withdrawnDecisions: 1 }],
    ['a decision withdrawn 24 hours and 1 minute ago', closed({ closeReason: 'withdrawn' }, DECISION_RECENT_WINDOW_MS + 60_000), { endedGrants: 0, withdrawnDecisions: 0 }],
    ['a grant ended 24 hours and 1 minute ago', closed({ closeWhen: at(NOW - 25 * HOUR, true), closeReason: 'condition' }, DECISION_RECENT_WINDOW_MS + 60_000), { endedGrants: 0, withdrawnDecisions: 0 }],
    ['a closed time as shown (ISO)', decision({ state: 'closed', closedAt: new Date(NOW - HOUR).toISOString(), closeReason: 'withdrawn' }), { endedGrants: 0, withdrawnDecisions: 1 }],
  ] as const)('%s → %o', (_name, item, expected) => {
    const counts = decisionCountsOf('on', [item], NOW);
    expect(counts).toMatchObject(expected);
    expect(counts.open).toBe(0);
  });

  it('a closed note is not a decision', () => {
    expect(decisionCountsOf('on', [{ kind: 'note', state: 'closed', closedAt: NOW, closeReason: 'withdrawn' }], NOW)).toMatchObject({ withdrawnDecisions: 0 });
  });
});

describe('ambiguous: unknown, never 0', () => {
  it.each([undefined, NOW])('clock %s: every field is null', (now) => {
    const counts = now === undefined ? decisionCountsOf('ambiguous' as DecisionCountsMode, [decision({})]) : decisionCountsOf('ambiguous', [decision({})], now);
    for (const value of Object.entries(counts).filter(([key]) => key !== 'mode' && key !== 'approvable').map(([, v]) => v)) expect(value).toBeNull();
    if (now !== undefined) expect(Object.keys(counts).sort()).toEqual(['approvable', 'endedGrants', 'expiredGrants', 'grants', 'mode', 'noDestination', 'open', 'pending', 'recorded', 'withdrawnDecisions']);
  });
});
