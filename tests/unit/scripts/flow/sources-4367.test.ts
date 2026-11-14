/**
 * T-P (Issue #4367 PR1a, docs/design/flow-metrics-4367.md §7.1): the population of the two
 * metrics. Each row runs for `prCreated` and `prMerged`. A value is "the count the search
 * returned" (`coverage: search-observed`); `complete` is never true (R7 disposition).
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { makeRunBounded } from '../../../../scripts/flow/runner.mjs';
import { readPrCounts } from '../../../../scripts/flow/sources.mjs';
import { ghByKind, holds, ok, prList, type RunAnswer } from './flow-fakes';

type Kind = 'prCreated' | 'prMerged';
type Impl = typeof readPrCounts;
interface Metric {
  value: number | null;
  complete: boolean;
  coverage: string;
  why?: string;
  limit: number;
}

const FROM = Date.parse('2026-11-13T00:00:00.000Z');
const TO = Date.parse('2026-11-14T00:00:00.000Z');
const IN = '2026-11-13T05:00:00Z';
const FIELD = { prCreated: 'createdAt', prMerged: 'mergedAt' } as const;
const OTHER: Record<Kind, Kind> = { prCreated: 'prMerged', prMerged: 'prCreated' };

/** Runs `impl` with `answer` for `kind` and an empty list for the other metric. */
function observe(kind: Kind, answer: RunAnswer, impl: Impl = readPrCounts, deadlineMono = 1e9): Metric {
  const empty = ok('[]');
  const gh = kind === 'prCreated' ? ghByKind(answer, empty) : ghByKind(empty, answer);
  const runBounded = makeRunBounded({ run: (_c: string, args: string[]) => gh(args), monoNow: () => 0 });
  const r = impl(runBounded, { repo: 'Kewton/CommandMate', base: 'develop', window: { from: FROM, to: TO }, deadlineMono });
  return r[kind] as Metric;
}

const list = (kind: Kind, items: Array<[number, string]>) => ok(prList(FIELD[kind], items));
const many = (kind: Kind, n: number) => list(kind, Array.from({ length: n }, (_, i) => [i + 1, IN] as [number, string]));

/** The rows of §7.1 as checks over an implementation (T-M swaps the implementation). */
const ROWS: Record<string, (kind: Kind, impl: Impl) => void> = {
  'P1(b) empty answer: observed 0, never complete': (kind, impl) => {
    const m = observe(kind, ok('[]'), impl);
    expect(m.value).toBe(0);
    expect(m.coverage).toBe('search-observed');
    expect(m.complete).toBe(false);
  },
  'P2 three in the window': (kind, impl) => {
    const m = observe(kind, list(kind, [[1, IN], [2, IN], [3, IN]]), impl);
    expect(m.value).toBe(3);
    expect(m.complete).toBe(false);
  },
  'P3 999 (under the limit): observed, never complete': (kind, impl) => {
    const m = observe(kind, many(kind, 999), impl);
    expect(m.value).toBe(999);
    expect(m.complete).toBe(false);
  },
  'P4 1000 (the limit): null truncated': (kind, impl) => {
    const m = observe(kind, many(kind, 1000), impl);
    expect(m.value).toBeNull();
    expect(m.why).toBe('truncated');
  },
  'P5 exit 1 HTTP 502: null fail': (kind, impl) => {
    const m = observe(kind, { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }, impl);
    expect(m.value).toBeNull();
    expect(m.why).toBe('fail');
  },
  'P6 exit 1 HTTP 404: null denied': (kind, impl) => {
    const m = observe(kind, { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' }, impl);
    expect(m.value).toBeNull();
    expect(m.why).toBe('denied');
  },
  'P7 no budget: null timeout': (kind, impl) => {
    const m = observe(kind, ok('[]'), impl, 0);
    expect(m.value).toBeNull();
    expect(m.why).toBe('timeout');
  },
  'P8 not JSON / not an array: null schema': (kind, impl) => {
    for (const stdout of ['not json', '{"number":1}']) {
      const m = observe(kind, ok(stdout), impl);
      expect(m.value).toBeNull();
      expect(m.why).toBe('schema');
    }
  },
  'P9 one bad element: null schema': (kind, impl) => {
    const good = { number: 1, [FIELD[kind]]: IN, baseRefName: 'develop' };
    const bads = [
      { number: 2, [FIELD[kind]]: 'yesterday', baseRefName: 'develop' },
      { number: '3', [FIELD[kind]]: IN, baseRefName: 'develop' },
      { number: 4, [FIELD[kind]]: IN, baseRefName: 'main' },
      { number: 5, [FIELD[kind]]: null, baseRefName: 'develop' },
    ];
    for (const bad of bads) {
      const m = observe(kind, ok(JSON.stringify([good, bad])), impl);
      expect(m.value, JSON.stringify(bad)).toBeNull();
      expect(m.why).toBe('schema');
    }
  },
  'P10 the same number twice, same time: counted once': (kind, impl) => {
    const m = observe(kind, list(kind, [[7, IN], [7, IN]]), impl);
    expect(m.value).toBe(1);
  },
  'P11 the same number twice, different times: null conflict': (kind, impl) => {
    const m = observe(kind, list(kind, [[7, IN], [7, '2026-11-13T06:00:00Z']]), impl);
    expect(m.value).toBeNull();
    expect(m.why).toBe('conflict');
  },
  'P12 1 ms before from and exactly to: not counted': (kind, impl) => {
    const m = observe(kind, list(kind, [[1, '2026-11-12T23:59:59.999Z'], [2, '2026-11-14T00:00:00.000Z']]), impl);
    expect(m.value).toBe(0);
  },
  'P13 exactly from and 1 ms before to: counted': (kind, impl) => {
    const m = observe(kind, list(kind, [[1, '2026-11-13T00:00:00.000Z'], [2, '2026-11-13T23:59:59.999Z']]), impl);
    expect(m.value).toBe(2);
  },
  'P14 this one fails, the other stays': (kind, impl) => {
    const failing: RunAnswer = { status: 1, stdout: '', stderr: 'HTTP 502' };
    const good = ok(prList(FIELD[OTHER[kind]], [[1, IN]]));
    const gh = kind === 'prCreated' ? ghByKind(failing, good) : ghByKind(good, failing);
    const runBounded = makeRunBounded({ run: (_c: string, args: string[]) => gh(args), monoNow: () => 0 });
    const r = impl(runBounded, { repo: 'Kewton/CommandMate', base: 'develop', window: { from: FROM, to: TO }, deadlineMono: 1e9 });
    expect((r[kind] as Metric).value).toBeNull();
    expect((r[OTHER[kind]] as Metric).value).toBe(1);
  },
};

const KINDS: Kind[] = ['prCreated', 'prMerged'];
const CASES = Object.keys(ROWS).flatMap((row) => KINDS.map((kind) => [row, kind] as const));

describe('T-P: the population of prCreated / prMerged (§7.1)', () => {
  it.each(CASES)('%s — %s', (row, kind) => {
    ROWS[row](kind, readPrCounts);
  });

  it('P17 created before the window, merged in it: in prMerged (the search key is merged)', () => {
    const m = observe('prMerged', list('prMerged', [[9, '2026-11-13T00:10:00Z']]));
    expect(m.value).toBe(1);
  });

  it('a value carries coverage search-observed and the limit, a failure keeps the same keys', () => {
    expect(observe('prCreated', ok('[]'))).toEqual(
      expect.objectContaining({ value: 0, coverage: 'search-observed', complete: false, limit: 1000 })
    );
    expect(observe('prCreated', { status: 1, stderr: 'HTTP 502' })).toEqual(
      expect.objectContaining({ value: null, coverage: 'search-observed', complete: false, why: 'fail', limit: 1000 })
    );
  });
});

/*
 * R7 (prereview-4367-3 §3): the same normal answer cannot tell (a) "the search covered the
 * population" from (b) "the index had not caught up". PR1a has no evidence for (a), so a
 * version that turns a normal answer into `complete: true` is red on P1 and P3 — for an empty
 * answer and for a known non-empty one, for both metrics. The observed value stays (negative).
 */
describe('R7: a normal search answer is observed, not complete', () => {
  const claimsComplete: Impl = (rb, o) => {
    const r = readPrCounts(rb, o);
    const mark = (m: Metric) => (m.value === null ? m : { ...m, complete: true });
    return { ...r, prCreated: mark(r.prCreated as Metric), prMerged: mark(r.prMerged as Metric) };
  };
  it.each(KINDS)('%s: the version that calls an empty / 999 answer complete is red on P1(b) and P3', (kind) => {
    expect(holds(() => ROWS['P1(b) empty answer: observed 0, never complete'](kind, claimsComplete))).toBe(false);
    expect(holds(() => ROWS['P3 999 (under the limit): observed, never complete'](kind, claimsComplete))).toBe(false);
  });
  it.each(KINDS)('%s: (negative) the observed value is the same either way', (kind) => {
    expect(observe(kind, ok('[]'), claimsComplete).value).toBe(observe(kind, ok('[]')).value);
    expect(observe(kind, many(kind, 999), claimsComplete).value).toBe(999);
  });
});

/** Rewrites one search answer before the real implementation sees it. */
function rewriting(rewrite: (stdout: string, args: string[]) => string): Impl {
  return (rb, o) =>
    readPrCounts(((cmd: string, args: string[], opt: unknown) => {
      const r = (rb as (c: string, a: string[], p: unknown) => { status: string; stdout?: string })(cmd, args, opt);
      return r.status === 'ok' ? { ...r, stdout: rewrite(String(r.stdout ?? ''), args) } : r;
    }) as Parameters<Impl>[0], o);
}

describe('T-M M1〜M4: each guard of §2.3 removed turns its row red (§7.5)', () => {
  const MUTANTS: Array<[string, Impl, string[]]> = [
    // M1: a value at the limit — the answer cut to 999 so the limit check never sees 1000.
    ['M1 a value even at the limit', rewriting((s) => {
      const a = JSON.parse(s);
      return Array.isArray(a) && a.length >= 1000 ? JSON.stringify(a.slice(0, 999)) : s;
    }), ['P4 1000 (the limit): null truncated']],
    // M2: a failure read as 0.
    ['M2 a failure becomes 0', ((rb, o) => {
      const r = readPrCounts(rb, o);
      const zero = (m: Metric) => (m.value === null ? { ...m, value: 0, why: undefined } : m);
      return { ...r, prCreated: zero(r.prCreated as Metric), prMerged: zero(r.prMerged as Metric) };
    }) as Impl, ['P5 exit 1 HTTP 502: null fail', 'P6 exit 1 HTTP 404: null denied', 'P7 no budget: null timeout', 'P8 not JSON / not an array: null schema', 'P9 one bad element: null schema']],
    // M3: a bad element skipped instead of failing the whole answer.
    ['M3 bad elements skipped one by one', rewriting((s, args) => {
      let a: unknown;
      try {
        a = JSON.parse(s);
      } catch {
        return s;
      }
      if (!Array.isArray(a)) return s;
      const field = args[13].includes('createdAt') ? 'createdAt' : 'mergedAt';
      return JSON.stringify(a.filter((e) => typeof e?.number === 'number' && e.baseRefName === 'develop' && typeof e[field] === 'string' && /T/.test(e[field])));
    }), ['P9 one bad element: null schema']],
    // M4: the closed interval [from, to].
    ['M4 the window closed at to', ((rb, o) => readPrCounts(rb, { ...o, window: { from: o.window.from, to: o.window.to + 1 } })) as Impl, ['P12 1 ms before from and exactly to: not counted']],
  ];

  it.each(MUTANTS)('%s', (_name, mutant, rows) => {
    for (const row of rows) {
      for (const kind of KINDS) {
        expect(holds(() => ROWS[row](kind, readPrCounts)), `${row} real ${kind}`).toBe(true);
        expect(holds(() => ROWS[row](kind, mutant)), `${row} mutant ${kind}`).toBe(false);
      }
    }
  });
});
