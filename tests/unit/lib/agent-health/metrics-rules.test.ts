/**
 * Issue #3044: which metrics become Issue candidates. Only what is newly over
 * a threshold or worse than the previous run is a candidate; a second run
 * with nothing changed has no candidates.
 */

import { describe, expect, it } from 'vitest';
import { parseMetricsArgs } from '@/lib/agent-health/metrics-args';
import { measureFileSize, measureTypeSafety } from '@/lib/agent-health/metrics-parse';
import {
  buildQueue,
  decideMetricsExitCode,
  evaluateAll,
  evaluateMetric,
  isCoverageDay,
  metricKey,
  nextMetricsState,
  parseMetricsState,
} from '@/lib/agent-health/metrics-rules';
import type { MetricFinding, MetricMeasurement, MetricSnapshot, MetricsReport } from '@/lib/agent-health/metrics-types';

const NOW = new Date('2026-10-01T21:30:00.000Z'); // 2026-10-02 06:30 JST (Friday)

function measured(
  metricId: MetricMeasurement['metricId'],
  items: Record<string, number>,
  findings: Record<string, MetricFinding> = {},
  value: number | null = Object.keys(findings).length
): MetricMeasurement {
  return { metricId, status: 'ok', value, items, findings };
}

function snapshotOf(m: MetricMeasurement): MetricSnapshot {
  if (m.status !== 'ok') throw new Error('skip has no snapshot');
  return { measuredAt: '2026-09-30T21:30:00.000Z', value: m.value, items: m.items };
}

const finding = (target: string, extra: Partial<MetricFinding> = {}): MetricFinding => ({
  target,
  title: `title ${target}`,
  ...extra,
});

describe('keys', () => {
  it('is metrics:<metricId>:<target>', () => {
    expect(metricKey('npm-audit', 'ws')).toBe('metrics:npm-audit:ws');
  });
});

describe('the second run with nothing changed has no candidates', () => {
  const measurements: MetricMeasurement[] = [
    measured('npm-audit', { 'ws:GHSA-1': 3 }, { ws: finding('ws', { severity: 'high', itemKeys: ['ws:GHSA-1'] }) }, 1),
    measured('semgrep', { 'r:src/a.ts': 1 }, { 'r:src/a.ts': finding('r:src/a.ts', { severity: 'high' }) }),
    measured('secrets', { fp: 1 }, { fp: finding('fp', { severity: 'critical' }) }),
    measureFileSize({ 'src/big.ts': 3195, 'src/mid.ts': 900 }),
    measured('complexity', { 'src/a.ts': 40 }, { 'src/a.ts': finding('src/a.ts') }),
    measured('duplication', { percentage: 1.16 }, {}, 1.16),
    measured('unused', { 'left-pad': 1 }, { 'left-pad': finding('left-pad') }),
    measured('outdated', { next: 2 }, { next: finding('next') }),
    measureTypeSafety({ any: 36, eslintDisable: 167, tsIgnore: 1 }),
    measured('coverage', { lines: 70 }, {}, 70),
  ];

  it('the first run is a baseline: no candidates, security findings are outstanding', () => {
    const results = evaluateAll(measurements, null);
    expect(results.flatMap((r) => r.candidates)).toEqual([]);
    const audit = results.find((r) => r.metricId === 'npm-audit')!;
    expect(audit.status).toBe('fail');
    expect(audit.outstanding?.map((c) => c.key)).toEqual(['metrics:npm-audit:ws']);
    expect(results.find((r) => r.metricId === 'file-size')!.status).toBe('pass');
  });

  it('the second run, same values: still no candidates', () => {
    const state = nextMetricsState(null, measurements, NOW);
    const results = evaluateAll(measurements, state);
    expect(results.flatMap((r) => r.candidates)).toEqual([]);
    expect(results.filter((r) => r.category === 'maintainability').every((r) => r.status === 'pass')).toBe(true);
    // persisting security findings stay offered, but never as candidates
    expect(results.find((r) => r.metricId === 'secrets')!.outstanding).toHaveLength(1);
    expect(results.find((r) => r.metricId === 'semgrep')!.outstanding).toBeUndefined();
  });
});

describe('security', () => {
  it('a package is a candidate again when it gains a new advisory', () => {
    const before = measured('npm-audit', { 'ws:GHSA-1': 3 }, { ws: finding('ws', { itemKeys: ['ws:GHSA-1'] }) });
    const after = measured(
      'npm-audit',
      { 'ws:GHSA-1': 3, 'ws:GHSA-2': 3, 'undici:GHSA-3': 4 },
      {
        ws: finding('ws', { severity: 'high', itemKeys: ['ws:GHSA-1', 'ws:GHSA-2'] }),
        undici: finding('undici', { severity: 'critical', itemKeys: ['undici:GHSA-3'] }),
      }
    );
    const result = evaluateMetric(after, snapshotOf(before));
    expect(result.candidates.map((c) => c.key).sort()).toEqual(['metrics:npm-audit:undici', 'metrics:npm-audit:ws']);
    expect(result.outstanding).toEqual([]);
  });

  it('semgrep: only new ERROR findings; secrets: any finding fails', () => {
    const prev = snapshotOf(measured('semgrep', { old: 1 }, { old: finding('old') }));
    const result = evaluateMetric(measured('semgrep', { old: 1, fresh: 1 }, { old: finding('old'), fresh: finding('fresh') }), prev);
    expect(result.candidates.map((c) => c.key)).toEqual(['metrics:semgrep:fresh']);
    expect(evaluateMetric(measured('secrets', {}, {}), null).status).toBe('pass');
  });
});

describe('file-size', () => {
  const prev = snapshotOf(measureFileSize({ 'src/big.ts': 3000, 'src/near.ts': 1400, 'src/mid.ts': 600, 'src/small.ts': 100 }));

  it('newly over 1,500 lines, or +200 lines since the previous run, is a candidate', () => {
    const now = measureFileSize({
      'src/big.ts': 3199, // +199: not yet
      'src/near.ts': 1501, // crossed
      'src/mid.ts': 800, // +200
      'src/small.ts': 350, // +250 but under the 500-line floor
      'src/new.ts': 1600, // a new file already over
    });
    const result = evaluateMetric(now, prev);
    expect(result.candidates.map((c) => c.key).sort()).toEqual([
      'metrics:file-size:src/mid.ts',
      'metrics:file-size:src/near.ts',
      'metrics:file-size:src/new.ts',
    ]);
    expect(result.candidates.find((c) => c.key.endsWith('mid.ts'))!.delta).toBe(200);
    expect(result.status).toBe('fail');
  });

  it('files already over the limit are counted, not filed', () => {
    const result = evaluateMetric(measureFileSize({ 'src/big.ts': 3000 }), prev);
    expect(result.candidates).toEqual([]);
    expect(result.value).toBe(1);
  });
});

describe('complexity / outdated', () => {
  it('complexity: entering the 25+ band or +5 within it', () => {
    const prev = snapshotOf(measured('complexity', { 'src/a.ts': 30, 'src/b.ts': 20, 'src/c.ts': 40 }));
    const now = measured(
      'complexity',
      { 'src/a.ts': 34, 'src/b.ts': 25, 'src/c.ts': 45 },
      { 'src/a.ts': finding('src/a.ts'), 'src/b.ts': finding('src/b.ts'), 'src/c.ts': finding('src/c.ts') }
    );
    const keys = evaluateMetric(now, prev).candidates.map((c) => c.key).sort();
    expect(keys).toEqual(['metrics:complexity:src/b.ts', 'metrics:complexity:src/c.ts']);
  });

  it('outdated: only a dependency that newly fell 2 majors behind', () => {
    const prev = snapshotOf(measured('outdated', { next: 2, zod: 1 }));
    const now = measured('outdated', { next: 3, zod: 2 }, { next: finding('next'), zod: finding('zod') });
    expect(evaluateMetric(now, prev).candidates.map((c) => c.key)).toEqual(['metrics:outdated:zod']);
  });
});

describe('scalar metrics', () => {
  it('duplication: +0.5pt is a candidate, +0.4pt is not', () => {
    const prev = snapshotOf(measured('duplication', { percentage: 1.16 }));
    expect(evaluateMetric(measured('duplication', { percentage: 1.56 }), prev).candidates).toEqual([]);
    const worse = evaluateMetric(measured('duplication', { percentage: 1.66 }), prev);
    expect(worse.candidates.map((c) => c.key)).toEqual(['metrics:duplication:src']);
    expect(worse.candidates[0].delta).toBe(0.5);
  });

  it('type-safety: any increase is a candidate; a decrease is not', () => {
    const prev = snapshotOf(measureTypeSafety({ any: 36, eslintDisable: 167, tsIgnore: 1 }));
    expect(evaluateMetric(measureTypeSafety({ any: 35, eslintDisable: 160, tsIgnore: 1 }), prev).candidates).toEqual([]);
    const worse = evaluateMetric(measureTypeSafety({ any: 38, eslintDisable: 160, tsIgnore: 1 }), prev);
    expect(worse.candidates).toHaveLength(1);
    expect(worse.candidates[0].title).toContain('any +2');
  });

  it('coverage: a drop of 2 points against the previous measurement', () => {
    const prev = snapshotOf(measured('coverage', { lines: 70 }));
    expect(evaluateMetric(measured('coverage', { lines: 68.01 }), prev).candidates).toEqual([]);
    expect(evaluateMetric(measured('coverage', { lines: 68 }), prev).candidates).toHaveLength(1);
  });
});

describe('skip and state', () => {
  it('a skip carries the reason and no value', () => {
    const result = evaluateMetric({ metricId: 'secrets', status: 'skip', reason: 'gitleaks が見つからない' }, null);
    expect(result).toMatchObject({ status: 'skip', value: null, candidates: [], skipReason: 'gitleaks が見つからない' });
    expect(result.category).toBe('security');
  });

  it('a skipped metric keeps its previous snapshot (the next run compares with the last real value)', () => {
    const first = nextMetricsState(null, [measured('coverage', { lines: 70 }, {}, 70)], NOW);
    const second = nextMetricsState(first, [{ metricId: 'coverage', status: 'skip', reason: 'not Monday' }], new Date());
    expect(second.metrics.coverage).toEqual(first.metrics.coverage);
  });

  it('round-trips through JSON and tolerates junk', () => {
    const state = nextMetricsState(null, [measureTypeSafety({ any: 1, eslintDisable: 2, tsIgnore: 3 })], NOW);
    expect(parseMetricsState(JSON.stringify(state))).toEqual(state);
    expect(parseMetricsState(null)).toBeNull();
    expect(parseMetricsState('{')).toBeNull();
    expect(parseMetricsState('{"metrics":[]}')).toBeNull();
    expect(
      parseMetricsState(JSON.stringify({ metrics: { bogus: {}, 'file-size': { measuredAt: 'x', items: { a: 'NaN', b: 2 } } } }))
    ).toEqual({ schemaVersion: 1, metrics: { 'file-size': { measuredAt: 'x', value: null, items: { b: 2 } } } });
  });
});

describe('queue', () => {
  it('security candidates by severity, then maintainability by score, then outstanding', () => {
    const results = evaluateAll(
      [
        measured('file-size', {}),
        measured('npm-audit', {}),
        measured('secrets', {}),
      ],
      null
    );
    results[0].candidates = [{ key: 'metrics:npm-audit:ws', title: 't', severity: 'high' }];
    results[0].outstanding = [{ key: 'metrics:npm-audit:old', title: 't', severity: 'critical' }];
    results[1].candidates = [{ key: 'metrics:secrets:fp', title: 't', severity: 'critical' }];
    results[2].candidates = [
      { key: 'metrics:file-size:small', title: 't', score: 1 },
      { key: 'metrics:file-size:large', title: 't', score: 3 },
    ];
    expect(buildQueue(results).map((e) => `${e.source}:${e.key}`)).toEqual([
      'candidate:metrics:secrets:fp',
      'candidate:metrics:npm-audit:ws',
      'candidate:metrics:file-size:large',
      'candidate:metrics:file-size:small',
      'outstanding:metrics:npm-audit:old',
    ]);
  });
});

describe('exit code and schedule', () => {
  const report = (statuses: Array<'pass' | 'fail' | 'skip'>, scriptErrors?: string[]): MetricsReport => ({
    schemaVersion: 1,
    startedAt: 'a',
    completedAt: 'b',
    metrics: statuses.map((status) => ({
      metricId: 'duplication',
      category: 'maintainability',
      status,
      value: null,
      summary: '',
      candidates: [],
    })),
    queue: [],
    host: { commandmateCommit: 'x', node: 'v24' },
    ...(scriptErrors ? { scriptErrors } : {}),
  });

  it('0 / 1 / 2', () => {
    expect(decideMetricsExitCode(report(['pass', 'skip']))).toBe(0);
    expect(decideMetricsExitCode(report(['pass', 'fail']))).toBe(1);
    expect(decideMetricsExitCode(report(['pass'], ['boom']))).toBe(2);
  });

  it('coverage runs on Monday in JST', () => {
    expect(isCoverageDay(new Date('2026-10-04T21:30:00.000Z'))).toBe(true); // Mon 06:30 JST
    expect(isCoverageDay(new Date('2026-10-05T12:00:00.000Z'))).toBe(true); // Mon 21:00 JST
    expect(isCoverageDay(new Date('2026-10-05T15:30:00.000Z'))).toBe(false); // Tue 00:30 JST
    expect(isCoverageDay(NOW)).toBe(false);
  });
});

describe('arguments', () => {
  it('defaults, --only, coverage switches', () => {
    const parsed = parseMetricsArgs([]);
    expect(parsed.ok && parsed.options).toMatchObject({ out: null, statePath: null, coverage: 'auto' });
    const only = parseMetricsArgs(['--only', 'semgrep,npm-audit', '--out=/tmp/x.json', '--state', '/tmp/s.json', '--no-coverage']);
    expect(only.ok && only.options).toEqual({
      out: '/tmp/x.json',
      statePath: '/tmp/s.json',
      metrics: ['npm-audit', 'semgrep'],
      coverage: 'off',
    });
    expect(parseMetricsArgs(['--coverage']).ok && parseMetricsArgs(['--coverage'])).toMatchObject({
      options: { coverage: 'on' },
    });
  });

  it('rejects unknown metrics, missing values and unknown flags; --help is not an error', () => {
    expect(parseMetricsArgs(['--only', 'nope']).ok).toBe(false);
    expect(parseMetricsArgs(['--out']).ok).toBe(false);
    expect(parseMetricsArgs(['--bogus']).ok).toBe(false);
    const help = parseMetricsArgs(['--help']);
    expect(!help.ok && help.help).toBe(true);
  });
});
