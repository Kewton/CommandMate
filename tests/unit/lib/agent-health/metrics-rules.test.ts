/**
 * Issue #3044: which metrics become Issue candidates. Only what is newly over
 * a threshold or worse than the previous run is a candidate; a second run
 * with nothing changed has no candidates.
 */

import { describe, expect, it } from 'vitest';
import { parseMetricsArgs } from '@/lib/agent-health/metrics-args';
import { measureFileSize, measureKnip, measureTypeSafety } from '@/lib/agent-health/metrics-parse';
import {
  addLogLine,
  createLogAggregate,
  measureApiLatency,
  measureErrorRate,
  measureLogVolume,
  measureServerProcess,
} from '@/lib/agent-health/metrics-perf';
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

describe('performance (Issue #3054)', () => {
  const NOW_MS = NOW.getTime();
  const at = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * 60 * 60 * 1000).toISOString();
  const logLine = (level: string, tag: string, event: string, data?: unknown) =>
    `[${at(1)}] [${level}] [${tag}] ${event}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`;
  const aggregateOf = (lines: string[]) => {
    const agg = createLogAggregate(NOW);
    addLogLine(agg, `[${at(30)}] [INFO] [boot] ready`);
    for (const raw of lines) addLogLine(agg, raw);
    return agg;
  };
  const repeat = (n: number, raw: string) => Array.from({ length: n }, () => raw);
  const slow = (n: number, totalMs: number) => repeat(n, logLine('WARN', 'api/worktrees', 'list:slow', { totalMs, probeMs: totalMs - 1 }));
  const snapshot = (m: MetricMeasurement): MetricSnapshot => snapshotOf(m);

  it('the first run has no candidates, but what is over a threshold is outstanding', () => {
    const errors = measureErrorRate(aggregateOf(repeat(50, logLine('ERROR', 'git-exec', 'git:command-failed'))));
    const result = evaluateMetric(errors, null);
    expect(result).toMatchObject({ category: 'performance', status: 'fail', candidates: [] });
    expect(result.outstanding?.map((c) => c.key)).toEqual(['metrics:error-rate:git-exec:git:command-failed']);
    expect(result.summary).toContain('初回');
  });

  it('newly over the threshold is a candidate; just under is not; still over is outstanding', () => {
    const before = measureErrorRate(aggregateOf([...repeat(49, logLine('ERROR', 'a', 'x')), ...repeat(60, logLine('ERROR', 'b', 'y'))]));
    const under = evaluateMetric(before, snapshot(measureErrorRate(aggregateOf(repeat(10, logLine('ERROR', 'a', 'x'))))));
    expect(under.candidates.map((c) => c.key)).toEqual(['metrics:error-rate:b:y']); // b is new and over; a (49) is not
    const after = measureErrorRate(aggregateOf([...repeat(50, logLine('ERROR', 'a', 'x')), ...repeat(60, logLine('ERROR', 'b', 'y'))]));
    const result = evaluateMetric(after, snapshot(before));
    expect(result.candidates.map((c) => c.key)).toEqual(['metrics:error-rate:a:x']);
    expect(result.candidates[0].evidence).toContain('前回 49 行');
    expect(result.outstanding?.map((c) => c.key)).toEqual(['metrics:error-rate:b:y']);
    expect(result.status).toBe('fail');
  });

  it('error-rate / log-volume: doubling counts only from the floor', () => {
    const prev = measureErrorRate(aggregateOf([...repeat(20, logLine('ERROR', 'a', 'x')), ...repeat(50, logLine('ERROR', 'b', 'y'))]));
    // a: 20 → 40 (below the floor of 50 last time); b: 50 → 99 (just under ×2) — neither a candidate
    const near = measureErrorRate(aggregateOf([...repeat(40, logLine('ERROR', 'a', 'x')), ...repeat(99, logLine('ERROR', 'b', 'y'))]));
    expect(evaluateMetric(near, snapshot(prev)).candidates).toEqual([]);
    const doubled = measureErrorRate(aggregateOf([...repeat(40, logLine('ERROR', 'a', 'x')), ...repeat(100, logLine('ERROR', 'b', 'y'))]));
    expect(evaluateMetric(doubled, snapshot(prev)).candidates.map((c) => c.key)).toEqual(['metrics:error-rate:b:y']);

    const volPrev = measureLogVolume(aggregateOf(repeat(1000, logLine('INFO', 'p', 'q'))));
    const volNow = measureLogVolume(aggregateOf(repeat(2000, logLine('INFO', 'p', 'q'))));
    expect(evaluateMetric(volNow, snapshot(volPrev)).candidates.map((c) => c.key)).toEqual(['metrics:log-volume:p:q']);
    const volPrevSmall = measureLogVolume(aggregateOf(repeat(999, logLine('INFO', 'p', 'q'))));
    expect(evaluateMetric(volNow, snapshot(volPrevSmall)).candidates).toEqual([]);
  });

  it('api-latency: newly ≥ 5,000ms, or +50% with at least 20 lines', () => {
    const prev = measureApiLatency(aggregateOf(slow(20, 2000)));
    expect(evaluateMetric(measureApiLatency(aggregateOf(slow(20, 2999))), snapshot(prev)).candidates).toEqual([]);
    const worse = evaluateMetric(measureApiLatency(aggregateOf(slow(20, 3000))), snapshot(prev));
    expect(worse.candidates.map((c) => c.key)).toEqual(['metrics:api-latency:api/worktrees:list:slow']);
    expect(worse.status).toBe('fail');
    // +50% but only 19 lines
    expect(evaluateMetric(measureApiLatency(aggregateOf(slow(19, 3000))), snapshot(prev)).candidates).toEqual([]);
    // newly over the threshold with few lines
    const crossed = evaluateMetric(measureApiLatency(aggregateOf(slow(3, 5000))), snapshot(prev));
    expect(crossed.candidates).toHaveLength(1);
    // just under the threshold, few lines
    expect(evaluateMetric(measureApiLatency(aggregateOf(slow(3, 4999))), snapshot(prev)).candidates).toEqual([]);
    // still over: outstanding, not a candidate
    const stillOver = evaluateMetric(measureApiLatency(aggregateOf(slow(3, 6000))), snapshot(measureApiLatency(aggregateOf(slow(3, 5500)))));
    expect(stillOver.candidates).toEqual([]);
    expect(stillOver.outstanding).toHaveLength(1);
    // nothing slow: pass
    expect(evaluateMetric(measureApiLatency(aggregateOf([])), snapshot(prev)).status).toBe('pass');
  });

  it('server-process: RSS newly ≥ 1,500MB or +50%, CPU newly ≥ 50%; RSS stays outstanding', () => {
    const run = (rssMb: number, cpu: number) => measureServerProcess([{ rssKb: rssMb * 1024, cpu }], []);
    const prev = run(1000, 10);
    expect(evaluateMetric(run(1499, 49.9), snapshot(prev)).candidates).toEqual([]);
    expect(evaluateMetric(run(1500, 10), snapshot(prev)).candidates.map((c) => c.key)).toEqual(['metrics:server-process:rss']);
    expect(evaluateMetric(run(600, 10), snapshot(run(400, 10))).candidates.map((c) => c.key)).toEqual(['metrics:server-process:rss']);
    expect(evaluateMetric(run(500, 50), snapshot(prev)).candidates.map((c) => c.key)).toEqual(['metrics:server-process:cpu']);
    const still = evaluateMetric(run(1600, 60), snapshot(run(1550, 55)));
    expect(still.candidates).toEqual([]);
    expect(still.outstanding?.map((c) => c.key)).toEqual(['metrics:server-process:rss']);
    expect(evaluateMetric(run(1600, 10), null).outstanding?.map((c) => c.key)).toEqual(['metrics:server-process:rss']);
  });

  it('candidates and outstanding carry no value from a log line JSON', () => {
    const secrets = ['wt-private-1234', '/Users/someone/secret-repo', 'no such file'];
    const lines = [
      ...repeat(60, logLine('ERROR', 'slash-commands', 'error-parsing-skill-file-skillpath:', { error: `${secrets[2]} '${secrets[1]}'` })),
      ...repeat(25, `[${at(1)}] [WARN] [api/worktrees] [${secrets[0]}:claude] list:slow ${JSON.stringify({ totalMs: 9000, worktreeId: secrets[0], path: secrets[1] })}`),
    ];
    const agg = aggregateOf(lines);
    const measurements = [measureApiLatency(agg), measureLogVolume(agg), measureErrorRate(agg)];
    const first = evaluateAll(measurements, null);
    const state = nextMetricsState(null, [measureApiLatency(aggregateOf([])), measureLogVolume(aggregateOf([])), measureErrorRate(aggregateOf([]))], NOW);
    const second = evaluateAll(measurements, state);
    const text = JSON.stringify([first, second, buildQueue(second)]);
    expect(second.flatMap((r) => r.candidates).length).toBeGreaterThan(0);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });

  it('queue: security new → maintainability → performance new → security outstanding → performance outstanding', () => {
    const results = evaluateAll(
      [measured('file-size', {}), measured('npm-audit', {}), measured('error-rate', {}), measured('api-latency', {})],
      null
    );
    // METRIC_IDS order: npm-audit, file-size, api-latency, error-rate
    const [audit, size, latency, errors] = results;
    audit.candidates = [{ key: 'metrics:npm-audit:ws', title: 't', severity: 'high' }];
    audit.outstanding = [{ key: 'metrics:npm-audit:old', title: 't', severity: 'critical' }];
    size.candidates = [{ key: 'metrics:file-size:a', title: 't', score: 9 }];
    latency.candidates = [{ key: 'metrics:api-latency:x', title: 't', score: 1 }];
    latency.outstanding = [{ key: 'metrics:api-latency:old', title: 't', score: 2 }];
    errors.candidates = [{ key: 'metrics:error-rate:y', title: 't', score: 3 }];
    errors.outstanding = [{ key: 'metrics:error-rate:old', title: 't', score: 5 }];
    expect(buildQueue(results).map((e) => `${e.source}:${e.key}`)).toEqual([
      'candidate:metrics:npm-audit:ws',
      'candidate:metrics:file-size:a',
      'candidate:metrics:error-rate:y',
      'candidate:metrics:api-latency:x',
      'outstanding:metrics:npm-audit:old',
      'outstanding:metrics:error-rate:old',
      'outstanding:metrics:api-latency:old',
    ]);
  });

  it('--only accepts the performance metrics', () => {
    const parsed = parseMetricsArgs(['--only', 'api-latency,log-volume,error-rate,server-process']);
    expect(parsed).toMatchObject({ ok: true, options: { metrics: ['api-latency', 'log-volume', 'error-rate', 'server-process'] } });
  });
});

describe('unused files (knip)', () => {
  const knip = (files: string[]): MetricMeasurement => measureKnip(JSON.stringify({ files, issues: [] }));
  const keysOf = (current: string[], previous: string[] | null): string[] =>
    evaluateMetric(knip(current), previous === null ? null : snapshotOf(knip(previous))).candidates.map((c) => c.key);

  it('3 -> 4 files: only the new path is a candidate', () => {
    expect(keysOf(['a.ts', 'b.ts', 'c.ts', 'd.ts'], ['a.ts', 'b.ts', 'c.ts'])).toEqual(['metrics:unused:d.ts']);
  });

  it('same count with swapped content: the new path is a candidate', () => {
    expect(keysOf(['a.ts', 'b.ts', 'x.ts'], ['a.ts', 'b.ts', 'c.ts'])).toEqual(['metrics:unused:x.ts']);
  });

  it('first run records a baseline without candidates', () => {
    expect(keysOf(['a.ts', 'b.ts'], null)).toEqual([]);
  });

  it('unchanged set has no candidates', () => {
    expect(keysOf(['a.ts'], ['a.ts'])).toEqual([]);
  });
});
