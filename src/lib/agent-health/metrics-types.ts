/**
 * Security and maintainability metrics measured before the daily agent-health
 * check (Issue #3044). `scripts/agent-health/metrics.ts` writes a
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
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export type MetricCategory = 'security' | 'maintainability';

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
  /** Ordering weight inside the maintainability group: worsening ÷ its threshold. */
  score?: number;
}

export interface MetricResult {
  /** contract */
  metricId: MetricId;
  /** contract */
  category: MetricCategory;
  /** contract. security: fail while any finding exists; maintainability: fail when a candidate exists. */
  status: MetricStatus;
  /** contract. The metric's headline number (see docs/user-guide/agent-health.md); null when skipped. */
  value: number | null;
  /** contract. One line. */
  summary: string;
  /** contract. Newly over the threshold or worse than the previous run — the Issue candidates. */
  candidates: MetricCandidate[];
  /** Findings still present but not new (security only). Filed only when the daily cap has room. */
  outstanding?: MetricCandidate[];
  skipReason?: string;
  /** Counts kept for the record (e.g. files over 500 lines) — never filed. */
  details?: Record<string, number | string>;
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
  /** Candidates, then outstanding findings, in the order the AI should file them. */
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
      details?: Record<string, number | string>;
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
