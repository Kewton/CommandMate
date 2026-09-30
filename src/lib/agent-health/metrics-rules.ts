/**
 * Deciding what in a metrics run is an Issue candidate (Issue #3044).
 *
 * Pure. The rule every metric follows: only what is **newly** over a
 * threshold or **worse than the previous run** is a candidate. What was
 * already over the threshold last time is recorded as a count and never filed
 * again (the 82 files over 500 lines on 2026-10-01 stay a number). A metric
 * with no previous snapshot is a baseline: nothing is a candidate yet.
 *
 * Security findings that persist are `outstanding` rather than dropped: the
 * AI files them only when the day's cap of new Issues has room, so an
 * advisory deferred on day one is still offered on day two.
 */

import { reportDateJst } from './report';
import { severityRank } from './metrics-parse';
import {
  COMPLEXITY_ALERT,
  COMPLEXITY_WORSEN_DELTA,
  COVERAGE_DROP_PT,
  COVERAGE_WEEKDAY_JST,
  DUPLICATION_WORSEN_PT,
  FILE_SIZE_GROWTH,
  FILE_SIZE_GROWTH_FLOOR,
  FILE_SIZE_LIMIT,
  METRIC_CATEGORY,
  METRIC_IDS,
  OUTDATED_MAJOR_LAG,
  isMetricId,
  type MetricCandidate,
  type MetricFinding,
  type MetricId,
  type MetricMeasurement,
  type MetricResult,
  type MetricSnapshot,
  type MetricsQueueEntry,
  type MetricsReport,
  type MetricsState,
} from './metrics-types';

type OkMeasurement = Extract<MetricMeasurement, { status: 'ok' }>;

export function metricKey(metricId: MetricId, target: string): string {
  return `metrics:${metricId}:${target}`;
}

function candidateFrom(metricId: MetricId, finding: MetricFinding, extra: Partial<MetricCandidate> = {}): MetricCandidate {
  return {
    key: metricKey(metricId, finding.target),
    title: finding.title,
    ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
    ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}),
    ...extra,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sign(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

interface Evaluation {
  candidates: MetricCandidate[];
  outstanding?: MetricCandidate[];
  summary: string;
}

/** Findings that persist are outstanding; the ones the previous run did not have are candidates. */
function presenceRule(m: OkMeasurement, previous: MetricSnapshot | null, keepOutstanding: boolean): Evaluation {
  const candidates: MetricCandidate[] = [];
  const outstanding: MetricCandidate[] = [];
  for (const finding of Object.values(m.findings)) {
    const keys = finding.itemKeys ?? [finding.target];
    const isNew = previous !== null && keys.some((key) => !(key in previous.items));
    if (isNew) candidates.push(candidateFrom(m.metricId, finding));
    else if (keepOutstanding) outstanding.push(candidateFrom(m.metricId, finding));
  }
  const total = Object.keys(m.findings).length;
  const unit = m.metricId === 'npm-audit' ? `${m.value} 件（${total} パッケージ）` : `${total} 件`;
  const baseline = previous === null ? '（初回: 基準として記録）' : '';
  return {
    candidates,
    ...(keepOutstanding ? { outstanding } : {}),
    summary: `${unit}（新規 ${candidates.length} 件）${baseline}`,
  };
}

function evaluateFileSize(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const candidates: MetricCandidate[] = [];
  if (previous !== null) {
    for (const [file, lines] of Object.entries(m.items)) {
      const before = previous.items[file];
      const crossed = lines > FILE_SIZE_LIMIT && (before === undefined || before <= FILE_SIZE_LIMIT);
      const grew = before !== undefined && lines >= FILE_SIZE_GROWTH_FLOOR && lines - before >= FILE_SIZE_GROWTH;
      if (!crossed && !grew) continue;
      const delta = before === undefined ? lines : lines - before;
      const reason = crossed
        ? `新たに ${FILE_SIZE_LIMIT.toLocaleString('en-US')} 行を超えた`
        : `前回比 ${sign(delta)} 行`;
      candidates.push(
        candidateFrom(
          'file-size',
          m.findings[file] ?? { target: file, title: `refactor: ${file} の肥大化を止める（${lines} 行）` },
          {
            evidence: `${file}: ${before ?? '(無し)'} → ${lines} 行（${reason}）`,
            delta,
            score: crossed ? 1 + (lines - FILE_SIZE_LIMIT) / FILE_SIZE_GROWTH : delta / FILE_SIZE_GROWTH,
          }
        )
      );
    }
  }
  const over = Object.keys(m.findings).length;
  return {
    candidates,
    summary: `${FILE_SIZE_LIMIT.toLocaleString('en-US')} 行超 ${over} 本（候補 ${candidates.length} 件）${previous === null ? '（初回: 基準として記録）' : ''}`,
  };
}

function evaluateComplexity(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const candidates: MetricCandidate[] = [];
  if (previous !== null) {
    for (const finding of Object.values(m.findings)) {
      const now = m.items[finding.target];
      const before = previous.items[finding.target];
      const entered = before === undefined || before < COMPLEXITY_ALERT;
      const delta = now - (before ?? 0);
      if (!entered && delta < COMPLEXITY_WORSEN_DELTA) continue;
      candidates.push(
        candidateFrom('complexity', finding, {
          evidence: `${finding.evidence ?? finding.target}（前回 ${before ?? '10 未満'}）`,
          delta,
          score: entered ? 1 + (now - COMPLEXITY_ALERT) / COMPLEXITY_WORSEN_DELTA : delta / COMPLEXITY_WORSEN_DELTA,
        })
      );
    }
  }
  return {
    candidates,
    summary: `複雑度 ${COMPLEXITY_ALERT} 以上の関数 ${m.value ?? 0} 個（候補 ${candidates.length} 件）${previous === null ? '（初回: 基準として記録）' : ''}`,
  };
}

function evaluateDuplication(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const now = m.items.percentage;
  const before = previous?.items.percentage;
  const delta = before === undefined ? 0 : round2(now - before);
  const candidates =
    before !== undefined && delta >= DUPLICATION_WORSEN_PT
      ? [
          candidateFrom(
            'duplication',
            { target: 'src', title: `refactor: src/ の重複コードを減らす（${before}% → ${now}%）` },
            { evidence: `jscpd: 重複率 ${before}% → ${now}%（${sign(delta)}pt）`, delta, score: delta / DUPLICATION_WORSEN_PT }
          ),
        ]
      : [];
  return {
    candidates,
    summary: `重複率 ${now}%${before === undefined ? '（初回: 基準として記録）' : `（前回比 ${sign(delta)}pt）`}`,
  };
}

function evaluateOutdated(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const candidates: MetricCandidate[] = [];
  if (previous !== null) {
    for (const finding of Object.values(m.findings)) {
      const before = previous.items[finding.target];
      if (before !== undefined && before >= OUTDATED_MAJOR_LAG) continue;
      candidates.push(candidateFrom('outdated', finding, { delta: m.items[finding.target], score: 1 }));
    }
  }
  return {
    candidates,
    summary: `メジャー ${OUTDATED_MAJOR_LAG} 版以上遅れた直接依存 ${m.value ?? 0} 件（新規 ${candidates.length} 件）${previous === null ? '（初回: 基準として記録）' : ''}`,
  };
}

function evaluateTypeSafety(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const parts = Object.entries(m.items).map(([kind, now]) => {
    const before = previous?.items[kind];
    return { kind, now, before, delta: before === undefined ? 0 : now - before };
  });
  const increased = parts.filter((part) => part.delta > 0);
  const totalDelta = increased.reduce((sum, part) => sum + part.delta, 0);
  const text = parts.map((p) => `${p.kind} ${p.now}${p.before === undefined ? '' : `（${sign(p.delta)}）`}`).join(' / ');
  const candidates =
    previous !== null && increased.length > 0
      ? [
          candidateFrom(
            'type-safety',
            {
              target: 'src',
              title: `refactor: src/ の型安全の後退を戻す（${increased.map((p) => `${p.kind} ${sign(p.delta)}`).join('、')}）`,
            },
            { evidence: text, delta: totalDelta, score: totalDelta }
          ),
        ]
      : [];
  return { candidates, summary: `${text}${previous === null ? '（初回: 基準として記録）' : ''}` };
}

function evaluateCoverage(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  const now = m.items.lines;
  const before = previous?.items.lines;
  const drop = before === undefined ? 0 : round2(before - now);
  const candidates =
    before !== undefined && drop >= COVERAGE_DROP_PT
      ? [
          candidateFrom(
            'coverage',
            { target: 'lines', title: `test: 行カバレッジの低下を戻す（${before}% → ${now}%）` },
            {
              evidence: `vitest --coverage（unit）: lines ${before}% → ${now}%（${previous?.measuredAt.slice(0, 10)} の計測と比較）`,
              delta: drop,
              score: drop / COVERAGE_DROP_PT,
            }
          ),
        ]
      : [];
  return {
    candidates,
    summary: `lines ${now}%${before === undefined ? '（初回: 基準として記録）' : `（前回 ${before}%）`}`,
  };
}

function evaluate(m: OkMeasurement, previous: MetricSnapshot | null): Evaluation {
  switch (m.metricId) {
    case 'npm-audit':
    case 'secrets':
      return presenceRule(m, previous, true);
    case 'semgrep':
    case 'unused':
      return presenceRule(m, previous, false);
    case 'file-size':
      return evaluateFileSize(m, previous);
    case 'complexity':
      return evaluateComplexity(m, previous);
    case 'duplication':
      return evaluateDuplication(m, previous);
    case 'outdated':
      return evaluateOutdated(m, previous);
    case 'type-safety':
      return evaluateTypeSafety(m, previous);
    case 'coverage':
      return evaluateCoverage(m, previous);
  }
}

/**
 * One metric's result. Security metrics fail while any finding exists (a
 * high advisory is a problem whether or not it is new); maintainability
 * metrics fail only when something got worse.
 */
export function evaluateMetric(measurement: MetricMeasurement, previous: MetricSnapshot | null): MetricResult {
  const category = METRIC_CATEGORY[measurement.metricId];
  if (measurement.status === 'skip') {
    return {
      metricId: measurement.metricId,
      category,
      status: 'skip',
      value: null,
      summary: `skip: ${measurement.reason}`,
      candidates: [],
      skipReason: measurement.reason,
    };
  }
  const evaluation = evaluate(measurement, previous);
  const hasFindings = Object.keys(measurement.findings).length > 0;
  const failed = category === 'security' ? hasFindings : evaluation.candidates.length > 0;
  return {
    metricId: measurement.metricId,
    category,
    status: failed ? 'fail' : 'pass',
    value: measurement.value,
    summary: evaluation.summary,
    candidates: evaluation.candidates,
    ...(evaluation.outstanding ? { outstanding: evaluation.outstanding } : {}),
    ...(measurement.details ? { details: measurement.details } : {}),
  };
}

/**
 * The order the AI files Issues in: security candidates (most severe first),
 * then maintainability candidates (largest worsening first), then outstanding
 * security findings (most severe first).
 */
export function buildQueue(results: readonly MetricResult[]): MetricsQueueEntry[] {
  type Ranked = MetricsQueueEntry & { rank: number };
  const security: Ranked[] = [];
  const maintainability: Ranked[] = [];
  const outstanding: Ranked[] = [];
  for (const result of results) {
    for (const candidate of result.candidates) {
      const entry = { key: candidate.key, metricId: result.metricId, source: 'candidate' as const };
      if (result.category === 'security') security.push({ ...entry, rank: severityRank(candidate.severity) });
      else maintainability.push({ ...entry, rank: candidate.score ?? 0 });
    }
    for (const candidate of result.outstanding ?? []) {
      outstanding.push({
        key: candidate.key,
        metricId: result.metricId,
        source: 'outstanding',
        rank: severityRank(candidate.severity),
      });
    }
  }
  const byRank = (a: Ranked, b: Ranked) => b.rank - a.rank;
  return [...security.sort(byRank), ...maintainability.sort(byRank), ...outstanding.sort(byRank)].map(
    ({ key, metricId, source }) => ({ key, metricId, source })
  );
}

/** Results in {@link METRIC_IDS} order, each compared with its previous snapshot. */
export function evaluateAll(
  measurements: readonly MetricMeasurement[],
  state: MetricsState | null
): MetricResult[] {
  const rank = (id: MetricId) => METRIC_IDS.indexOf(id);
  return [...measurements]
    .sort((a, b) => rank(a.metricId) - rank(b.metricId))
    .map((m) => evaluateMetric(m, state?.metrics[m.metricId] ?? null));
}

/**
 * The state after this run: every measured metric replaces its snapshot;
 * a skipped one keeps the previous snapshot, so a day without network (or a
 * non-coverage day) compares the next run with the last real measurement.
 */
export function nextMetricsState(
  previous: MetricsState | null,
  measurements: readonly MetricMeasurement[],
  now: Date
): MetricsState {
  const metrics: MetricsState['metrics'] = { ...(previous?.metrics ?? {}) };
  for (const m of measurements) {
    if (m.status !== 'ok') continue;
    metrics[m.metricId] = { measuredAt: now.toISOString(), value: m.value, items: { ...m.items } };
  }
  return { schemaVersion: 1, metrics };
}

/** A state file's text; anything malformed is "no previous run" (per metric where possible). */
export function parseMetricsState(text: string | null): MetricsState | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = (parsed as { metrics?: unknown }).metrics;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const metrics: MetricsState['metrics'] = {};
  for (const [id, snapshot] of Object.entries(raw)) {
    if (!isMetricId(id) || typeof snapshot !== 'object' || snapshot === null) continue;
    const { measuredAt, value, items } = snapshot as Record<string, unknown>;
    if (typeof measuredAt !== 'string' || typeof items !== 'object' || items === null || Array.isArray(items)) continue;
    const clean: Record<string, number> = {};
    for (const [key, n] of Object.entries(items)) {
      if (typeof n === 'number' && Number.isFinite(n)) clean[key] = n;
    }
    metrics[id] = { measuredAt, value: typeof value === 'number' ? value : null, items: clean };
  }
  return { schemaVersion: 1, metrics };
}

/** `0` nothing failed, `1` at least one metric failed, `2` the script itself went wrong. */
export function decideMetricsExitCode(report: MetricsReport): 0 | 1 | 2 {
  if ((report.scriptErrors?.length ?? 0) > 0) return 2;
  return report.metrics.some((metric) => metric.status === 'fail') ? 1 : 0;
}

/** Coverage is heavy: it runs on one JST weekday (Monday) only. */
export function isCoverageDay(now: Date): boolean {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCDay() === COVERAGE_WEEKDAY_JST;
}

export { reportDateJst as metricsDateJst };
