/**
 * Security, maintainability (Issue #3044) and performance (Issue #3054)
 * metrics measured before the daily agent-health check. `scripts/agent-health/metrics.ts` writes a
 * {@link MetricsReport}; the scheduled AI (docs/agent-health/metrics-prompt.md)
 * turns its candidates into Issues, and the HTML view (#3046) only reads it.
 *
 * The fields of {@link MetricsReport} / {@link MetricResult} /
 * {@link MetricCandidate} marked "contract" are shared with #3045 and #3046:
 * adding fields is fine, renaming or removing them breaks those readers.
 */

export const METRIC_IDS = [
  'npm-audit',
  'semgrep',
  'secrets',
  'file-size',
  'complexity',
  'duplication',
  'unused',
  'outdated',
  'type-safety',
  'coverage',
  'api-latency',
  'log-volume',
  'error-rate',
  'server-process',
  'bug-flow',
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

/** `process`: how the work itself goes (Issue #3185); recorded only, never a candidate. */
export type MetricCategory = 'security' | 'maintainability' | 'performance' | 'process';

export const METRIC_CATEGORY: Record<MetricId, MetricCategory> = {
  'npm-audit': 'security',
  semgrep: 'security',
  secrets: 'security',
  'file-size': 'maintainability',
  complexity: 'maintainability',
  duplication: 'maintainability',
  unused: 'maintainability',
  outdated: 'maintainability',
  'type-safety': 'maintainability',
  coverage: 'maintainability',
  'api-latency': 'performance',
  'log-volume': 'performance',
  'error-rate': 'performance',
  'server-process': 'performance',
  'bug-flow': 'process',
};

export function isMetricId(value: string): value is MetricId {
  return (METRIC_IDS as readonly string[]).includes(value);
}

// ── Thresholds (initial values from the Issue; tune here) ──────────────────

/** npm-audit: advisories at or above this severity are findings. */
export const AUDIT_MIN_SEVERITY = 'high';
/** file-size: a file over this many lines is "too large". */
export const FILE_SIZE_LIMIT = 1500;
/** file-size: growth since the previous run that is a candidate on its own. */
export const FILE_SIZE_GROWTH = 200;
/** file-size: growth only counts for files at least this long (small files may grow freely). */
export const FILE_SIZE_GROWTH_FLOOR = 500;
/** file-size: also recorded (count only), matching the 2026-10-01 baseline of 82 files. */
export const FILE_SIZE_REPORT_LINES = 500;
/** complexity: ESLint reports functions at or above this (the measured population). */
export const COMPLEXITY_REPORT_MIN = 10;
/** complexity: a file whose most complex function reaches this is in the "top" band. */
export const COMPLEXITY_ALERT = 25;
/** complexity: growth of a top-band file's maximum that is a candidate. */
export const COMPLEXITY_WORSEN_DELTA = 5;
/** duplication: growth of the duplicated-lines percentage (points) that is a candidate. */
export const DUPLICATION_WORSEN_PT = 0.5;
/** outdated: a direct dependency this many majors behind `latest` is a finding. */
export const OUTDATED_MAJOR_LAG = 2;
/** coverage: a drop of this many points (lines) against the previous measurement. */
export const COVERAGE_DROP_PT = 2;
/** coverage runs only on this JST weekday (0 = Sunday … 1 = Monday). */
export const COVERAGE_WEEKDAY_JST = 1;

// performance (Issue #3054; initial values from the 2026-09-28〜10-01 production log)

/** api-latency / log-volume / error-rate read the log lines of this many hours (by each line's ISO time). */
export const PERF_LOG_WINDOW_HOURS = 24;
/** `logs/server.log` plus at most this many rotated `server.log.<N>`. */
export const PERF_LOG_MAX_ROTATED = 3;
/** api-latency: the `<tag> <event>` whose p95 is the metric's `value`. */
export const API_LATENCY_HEADLINE = 'api/worktrees list:slow';
/** api-latency: a p95 (ms) at or above this is over the threshold. */
export const API_LATENCY_P95_ALERT_MS = 5000;
/** api-latency: the +50% p95 rule needs at least this many lines. */
export const API_LATENCY_MIN_COUNT = 20;
/** api-latency: p95 growth against the previous run (0.5 = +50%) that is a candidate. */
export const API_LATENCY_WORSEN_RATIO = 0.5;
/** log-volume: one `<tag> <event>` with this many lines a day is over the threshold. */
export const LOG_VOLUME_ALERT_LINES = 20_000;
/** log-volume: growth factor against the previous run that is a candidate… */
export const LOG_VOLUME_GROWTH_FACTOR = 2;
/** …for names that had at least this many lines last time. */
export const LOG_VOLUME_GROWTH_FLOOR = 1000;
/** error-rate: one `<tag> <event>` with this many ERROR lines a day is over the threshold. */
export const ERROR_RATE_ALERT_LINES = 50;
/** error-rate: growth factor against the previous run that is a candidate… */
export const ERROR_RATE_GROWTH_FACTOR = 2;
/** …for names that had at least this many ERROR lines last time. */
export const ERROR_RATE_GROWTH_FLOOR = 50;
/** server-process: an RSS maximum (MB) at or above this is over the threshold. */
export const SERVER_RSS_ALERT_MB = 1500;
/** server-process: RSS growth against the previous run (0.5 = +50%) that is a candidate. */
export const SERVER_RSS_WORSEN_RATIO = 0.5;
/** server-process: a CPU average (%) newly at or above this is a candidate. */
export const SERVER_CPU_ALERT_PCT = 50;
/** server-process: `ps` samples and the interval between them. */
export const SERVER_SAMPLE_COUNT = 6;
export const SERVER_SAMPLE_INTERVAL_MS = 5000;
/** server-process: sequential `GET /api/worktrees` calls (their median goes to `details`). */
export const SERVER_API_CALLS = 3;
export const SERVER_API_URL = 'http://127.0.0.1:3000/api/worktrees';
export const SERVER_API_TIMEOUT_MS = 30_000;

/** Whole run budget; a scheduled run is cut at 15 minutes and the AI still has to file Issues. */
export const METRICS_BUDGET_SEC = 10 * 60;

// ── Report (contract with #3045 / #3046) ───────────────────────────────────

export type MetricStatus = 'pass' | 'fail' | 'skip';

export interface MetricCandidate {
  /** contract. `metrics:<metricId>:<target>` — the Issue identifier (`<!-- key -->`). */
  key: string;
  /** contract. One line; a usable Issue title. */
  title: string;
  /** contract. `critical` / `high` for security findings; absent otherwise. */
  severity?: string;
  /** What was measured, and what fixes it (fix version, semver-major or not, …). */
  evidence?: string;
  /** How much worse than the previous run, in the metric's unit (lines, points, …). */
  delta?: number;
  /** Ordering weight inside the maintainability / performance groups: worsening ÷ its threshold. */
  score?: number;
}

export interface MetricResult {
  /** contract */
  metricId: MetricId;
  /** contract */
  category: MetricCategory;
  /**
   * contract. security: fail while any finding exists; maintainability: fail when a candidate exists;
   * performance: fail while a candidate or an outstanding entry exists; process: never fails.
   */
  status: MetricStatus;
  /** contract. The metric's headline number (see docs/user-guide/agent-health.md); null when skipped. */
  value: number | null;
  /** contract. One line. */
  summary: string;
  /** contract. Newly over the threshold or worse than the previous run — the Issue candidates. */
  candidates: MetricCandidate[];
  /** Findings still present but not new (security and performance). Filed only when the daily cap has room. */
  outstanding?: MetricCandidate[];
  skipReason?: string;
  /** Counts kept for the record (e.g. files over 500 lines) — never filed. null: a rate with a 0 denominator. */
  details?: Record<string, number | string | null>;
}

export interface MetricsQueueEntry {
  key: string;
  metricId: MetricId;
  source: 'candidate' | 'outstanding';
}

export interface MetricsReport {
  /** contract */
  schemaVersion: 1;
  /** contract. ISO */
  startedAt: string;
  /** contract. ISO; its presence means the run finished. */
  completedAt: string;
  /** contract. In {@link METRIC_IDS} order. */
  metrics: MetricResult[];
  /** Candidates, then outstanding findings, in the order the AI should file them (see `buildQueue`). */
  queue: MetricsQueueEntry[];
  host: { commandmateCommit: string; node: string };
  /** Why the run exited 2. */
  scriptErrors?: string[];
}

// ── Measurement (runner → rules) and state ─────────────────────────────────

/** One thing over a threshold, as measured (before comparing with the previous run). */
export interface MetricFinding {
  /** The `<target>` part of the key; stable across runs. */
  target: string;
  title: string;
  severity?: string;
  evidence?: string;
  /**
   * The `items` entries this finding stands for (default: `[target]`). The
   * finding is new when any of them is missing from the previous run.
   */
  itemKeys?: string[];
}

/**
 * What a runner hands to the rules. `items` is what the next run compares
 * against (it goes to the state file as is); `findings` are the entries that
 * are over the threshold right now, keyed by target.
 */
export type MetricMeasurement =
  | {
      metricId: MetricId;
      status: 'ok';
      value: number | null;
      items: Record<string, number>;
      findings: Record<string, MetricFinding>;
      /**
       * Everything measured that the rules may raise even below the threshold
       * (performance: each `<tag> <event>`, which a growth rule can make a
       * candidate), keyed by target. `findings` is a subset.
       */
      subjects?: Record<string, MetricFinding>;
      details?: Record<string, number | string | null>;
    }
  | { metricId: MetricId; status: 'skip'; reason: string };

export interface MetricSnapshot {
  /** ISO time of the measurement. */
  measuredAt: string;
  value: number | null;
  items: Record<string, number>;
}

/** `~/.commandmate/agent-health/metrics-state.json` */
export interface MetricsState {
  schemaVersion: 1;
  metrics: Partial<Record<MetricId, MetricSnapshot>>;
}
