/**
 * Performance metrics from the production server's log and process
 * (Issue #3054). Pure: log lines and samples in, {@link MetricMeasurement}s
 * out. Reading the files, `ps` and the HTTP calls live in
 * `scripts/agent-health/metrics-runners.ts`.
 *
 * The repository is public, so nothing a log line carries in its JSON
 * (worktree ids, paths, messages, error text) may reach a title, evidence or
 * details: only `<tag> <event>` names, counts, durations and the names of the
 * `…Ms` breakdown fields. Names that do not look like code identifiers are
 * folded into `(other)`.
 */

import {
  API_LATENCY_HEADLINE,
  API_LATENCY_P95_ALERT_MS,
  ERROR_RATE_ALERT_LINES,
  LOG_VOLUME_ALERT_LINES,
  PERF_LOG_WINDOW_HOURS,
  SERVER_RSS_ALERT_MB,
  type MetricFinding,
  type MetricMeasurement,
} from './metrics-types';
import { addHookObservationLine, createHookObservationSamples, type HookObservationSamples } from './hook-observation';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface ParsedLogLine {
  /** Epoch ms of the line's leading ISO time. */
  time: number;
  level: LogLevel;
  /** `<tag> <event>`, both parts sanitized. */
  name: string;
  /** The JSON after the event, unparsed (null when absent). */
  data: string | null;
}

const LEVELS: readonly string[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
/** `[time] [LEVEL] [tag] [worktree:cli]? (request)? event {json}?` — src/lib/logger.ts formatLogEntry. */
const TEXT_LINE = /^\[(\d{4}-\d{2}-\d{2}T[^\]\s]+)\] \[([A-Z]+)\] \[([^\]]*)\](?: \[[^\]]*\])?(?: \([^)]*\))? (\S+)(?: (.*))?$/;
const SAFE_TAG = /^[A-Za-z0-9_.@-][A-Za-z0-9_.:@/-]{0,63}$/;
const SAFE_EVENT = /^[A-Za-z0-9_.:-]{1,80}$/;
const BREAKDOWN_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}Ms$/;
export const OTHER_NAME = '(other)';

function safePart(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : OTHER_NAME;
}

/** `<tag> <event>`; a trailing `:` of the event (`error-parsing-…-skillpath:`) is dropped. */
export function logName(tag: unknown, event: unknown): string {
  const trimmed = typeof event === 'string' ? event.replace(/:+$/, '') : event;
  return `${safePart(tag, SAFE_TAG)} ${safePart(trimmed, SAFE_EVENT)}`;
}

/** The target part of a metric key for a `<tag> <event>` name (no spaces). */
export function nameTarget(name: string): string {
  return name.replace(' ', ':');
}

function parseJsonLine(line: string): ParsedLogLine | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry !== 'object' || entry === null) return null;
  const { timestamp, level, module, action, data } = entry as Record<string, unknown>;
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const upper = typeof level === 'string' ? level.toUpperCase() : '';
  if (Number.isNaN(time) || !LEVELS.includes(upper)) return null;
  return {
    time,
    level: upper as LogLevel,
    name: logName(module, action),
    data: data === undefined ? null : JSON.stringify(data),
  };
}

/** One log line (text or JSON format); null for lines the logger did not write (npm banners, stack traces). */
export function parseLogLine(line: string): ParsedLogLine | null {
  if (line.startsWith('{')) return parseJsonLine(line);
  const match = TEXT_LINE.exec(line);
  if (!match) return null;
  const time = Date.parse(match[1]);
  if (Number.isNaN(time) || !LEVELS.includes(match[2])) return null;
  return { time, level: match[2] as LogLevel, name: logName(match[3], match[4]), data: match[5] ?? null };
}

// ── aggregation over the last 24 hours ─────────────────────────────────────

export interface LatencySamples {
  totals: number[];
  /** Sum of each `…Ms` breakdown field (other than `totalMs`). */
  breakdown: Record<string, number>;
}

export interface LogAggregate {
  windowStart: number;
  windowEnd: number;
  /** Earliest line time seen in any file (to tell whether the log reaches back 24 hours). */
  oldest: number | null;
  lines: number;
  byName: Record<string, number>;
  errors: Record<string, number>;
  latency: Record<string, LatencySamples>;
  /** The lines `hook-observation` reads (Issue #3311), from the same pass. */
  hook: HookObservationSamples;
}

export function createLogAggregate(now: Date, hours = PERF_LOG_WINDOW_HOURS): LogAggregate {
  const windowEnd = now.getTime();
  return {
    windowStart: windowEnd - hours * 60 * 60 * 1000,
    windowEnd,
    oldest: null,
    lines: 0,
    byName: {},
    errors: {},
    latency: {},
    hook: createHookObservationSamples(),
  };
}

function latencyOf(data: string | null): { total: number; breakdown: Record<string, number> } | null {
  if (data === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  const total = record.totalMs;
  if (typeof total !== 'number' || !Number.isFinite(total)) return null;
  const breakdown: Record<string, number> = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === 'totalMs' || !BREAKDOWN_FIELD.test(field)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) breakdown[field] = value;
  }
  return { total, breakdown };
}

/** Count one raw line into the aggregate (lines outside the window only move `oldest`). */
export function addLogLine(agg: LogAggregate, raw: string): void {
  const line = parseLogLine(raw);
  if (line === null) return;
  if (agg.oldest === null || line.time < agg.oldest) agg.oldest = line.time;
  if (line.time < agg.windowStart || line.time > agg.windowEnd) return;
  agg.lines++;
  agg.byName[line.name] = (agg.byName[line.name] ?? 0) + 1;
  if (line.level === 'ERROR') agg.errors[line.name] = (agg.errors[line.name] ?? 0) + 1;
  addHookObservationLine(agg.hook, line);
  if (line.level !== 'WARN') return;
  const latency = latencyOf(line.data);
  if (latency === null) return;
  const samples = (agg.latency[line.name] ??= { totals: [], breakdown: {} });
  samples.totals.push(latency.total);
  for (const [field, value] of Object.entries(latency.breakdown)) {
    samples.breakdown[field] = (samples.breakdown[field] ?? 0) + value;
  }
}

/** Why the aggregate cannot stand for a day (null when it can). */
export function logCoverageProblem(agg: LogAggregate): string | null {
  if (agg.lines === 0) return `直近 ${PERF_LOG_WINDOW_HOURS} 時間の行が無い`;
  if (agg.oldest === null || agg.oldest > agg.windowStart) {
    return `ログが直近 ${PERF_LOG_WINDOW_HOURS} 時間分に満たない（最古の行 ${new Date(agg.oldest ?? agg.windowEnd).toISOString()}）`;
  }
  return null;
}

/** Nearest-rank percentile, rounded to whole ms. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

const fmt = (n: number) => n.toLocaleString('en-US');

// ── api-latency ────────────────────────────────────────────────────────────

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** The breakdown field with the largest sum, or null when the lines had none. */
  topField: string | null;
  topFieldMs: number;
}

export function latencyStats(samples: LatencySamples): LatencyStats {
  let topField: string | null = null;
  let topFieldMs = 0;
  for (const [field, sum] of Object.entries(samples.breakdown)) {
    if (topField === null || sum > topFieldMs) {
      topField = field;
      topFieldMs = sum;
    }
  }
  return {
    count: samples.totals.length,
    p50: percentile(samples.totals, 50),
    p95: percentile(samples.totals, 95),
    max: Math.round(Math.max(...samples.totals)),
    topField,
    topFieldMs: Math.round(topFieldMs),
  };
}

/**
 * `items`: `p95:<target>` and `count:<target>` per `<tag> <event>`;
 * `subjects`: every name (the rules may raise any of them on a +50% p95);
 * `findings`: the names at or over {@link API_LATENCY_P95_ALERT_MS}.
 */
export function measureApiLatency(agg: LogAggregate): MetricMeasurement {
  const items: Record<string, number> = {};
  const subjects: Record<string, MetricFinding> = {};
  const findings: Record<string, MetricFinding> = {};
  for (const [name, samples] of Object.entries(agg.latency).sort(([a], [b]) => a.localeCompare(b))) {
    const stats = latencyStats(samples);
    const target = nameTarget(name);
    items[`p95:${target}`] = stats.p95;
    items[`count:${target}`] = stats.count;
    const top = stats.topField === null ? '' : ` / 内訳の最大 ${stats.topField}（合計 ${fmt(stats.topFieldMs)}ms）`;
    const subject: MetricFinding = {
      target,
      title: `perf: ${name} の遅延を減らす（p95 ${fmt(stats.p95)}ms）`,
      evidence: `${name}（直近 ${PERF_LOG_WINDOW_HOURS} 時間の WARN）: ${stats.count} 件 / p50 ${fmt(stats.p50)}ms / p95 ${fmt(stats.p95)}ms / 最大 ${fmt(stats.max)}ms${top}`,
      itemKeys: [`p95:${target}`],
    };
    subjects[target] = subject;
    if (stats.p95 >= API_LATENCY_P95_ALERT_MS) findings[target] = subject;
  }
  const headline = items[`p95:${nameTarget(API_LATENCY_HEADLINE)}`];
  return {
    metricId: 'api-latency',
    status: 'ok',
    value: headline ?? 0,
    items,
    findings,
    subjects,
    details: {
      names: Object.keys(subjects).length,
      lines: Object.values(agg.latency).reduce((sum, s) => sum + s.totals.length, 0),
    },
  };
}

// ── log-volume / error-rate ────────────────────────────────────────────────

function countMeasurement(
  metricId: 'log-volume' | 'error-rate',
  counts: Record<string, number>,
  alert: number,
  subjectOf: (name: string, count: number) => MetricFinding,
  details: Record<string, number | string>
): MetricMeasurement {
  const items: Record<string, number> = {};
  const subjects: Record<string, MetricFinding> = {};
  const findings: Record<string, MetricFinding> = {};
  let total = 0;
  for (const [name, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
    const subject = subjectOf(name, count);
    items[subject.target] = count;
    subjects[subject.target] = subject;
    if (count >= alert) findings[subject.target] = subject;
    total += count;
  }
  return { metricId, status: 'ok', value: total, items, findings, subjects, details: { ...details, names: Object.keys(items).length } };
}

function topNames(counts: Record<string, number>, n = 3): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([name, count]) => `${name} ${fmt(count)}`)
    .join(' / ');
}

export function measureLogVolume(agg: LogAggregate): MetricMeasurement {
  return countMeasurement(
    'log-volume',
    agg.byName,
    LOG_VOLUME_ALERT_LINES,
    (name, count) => ({
      target: nameTarget(name),
      title: `perf: ${name} のログ量を減らす（1 日 ${fmt(count)} 行）`,
      evidence: `${name}: 直近 ${PERF_LOG_WINDOW_HOURS} 時間 ${fmt(count)} 行（全体 ${fmt(agg.lines)} 行の ${Math.round((count / Math.max(1, agg.lines)) * 100)}%）`,
    }),
    { lines: agg.lines, top: topNames(agg.byName) }
  );
}

export function measureErrorRate(agg: LogAggregate): MetricMeasurement {
  return countMeasurement(
    'error-rate',
    agg.errors,
    ERROR_RATE_ALERT_LINES,
    (name, count) => ({
      target: nameTarget(name),
      title: `fix: ${name} の ERROR を減らす（1 日 ${fmt(count)} 行）`,
      evidence: `${name}: 直近 ${PERF_LOG_WINDOW_HOURS} 時間の [ERROR] ${fmt(count)} 行`,
    }),
    { top: topNames(agg.errors) }
  );
}

// ── server-process ─────────────────────────────────────────────────────────

export interface ProcessSample {
  rssKb: number;
  cpu: number;
}

/** One `ps -o rss=,%cpu= -p <pid>` output; null when the process is gone. */
export function parsePsSample(text: string): ProcessSample | null {
  const [rss, cpu] = text.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(rss) || !Number.isFinite(cpu) || rss <= 0) return null;
  return { rssKb: rss, cpu };
}

/** `ps -A -o pid=,ppid=,command=` rows. */
export function parsePsTable(text: string): Array<{ pid: number; ppid: number; command: string }> {
  const rows: Array<{ pid: number; ppid: number; command: string }> = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/**
 * The server's node process: `server.pid` is `npm start`, whose child runs
 * `node dist/server/server.js`. Falls back to the pid itself when it is that
 * process (started without npm). null when neither is running.
 */
export function findServerPid(pidFromFile: number, table: ReadonlyArray<{ pid: number; ppid: number; command: string }>): number | null {
  const isServer = (command: string) => /\bnode\b/.test(command) && /server\.js\b/.test(command);
  const child = table.find((row) => row.ppid === pidFromFile && isServer(row.command));
  if (child) return child.pid;
  const self = table.find((row) => row.pid === pidFromFile);
  return self && isServer(self.command) ? self.pid : null;
}

export type ApiProbe = { ok: true; ms: number } | { ok: false; reason: string };

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function measureServerProcess(samples: readonly ProcessSample[], probes: readonly ApiProbe[]): MetricMeasurement {
  if (samples.length === 0) return { metricId: 'server-process', status: 'skip', reason: 'サーバーのプロセスを計測できなかった' };
  const rssMaxMb = Math.round(Math.max(...samples.map((s) => s.rssKb)) / 1024);
  const cpuAvgPct = Math.round((samples.reduce((sum, s) => sum + s.cpu, 0) / samples.length) * 10) / 10;
  const cpuMaxPct = Math.max(...samples.map((s) => s.cpu));
  const details: Record<string, number | string> = { samples: samples.length, rssMaxMb, cpuAvgPct, cpuMaxPct };
  const okMs = probes.flatMap((probe) => (probe.ok ? [probe.ms] : []));
  if (okMs.length > 0) {
    details.apiWorktreesMedianMs = median(okMs);
    details.apiWorktreesCalls = okMs.length;
  }
  const failed = probes.find((probe): probe is { ok: false; reason: string } => !probe.ok);
  if (failed) details.apiWorktreesError = failed.reason;
  const subjects: Record<string, MetricFinding> = {
    rss: {
      target: 'rss',
      title: `perf: サーバーの RSS を減らす（最大 ${fmt(rssMaxMb)}MB）`,
      evidence: `node dist/server/server.js: RSS 最大 ${fmt(rssMaxMb)}MB（${samples.length} 回の計測）`,
      itemKeys: ['rssMaxMb'],
    },
    cpu: {
      target: 'cpu',
      title: `perf: サーバーの CPU 使用率を下げる（平均 ${cpuAvgPct}%）`,
      evidence: `node dist/server/server.js: CPU 平均 ${cpuAvgPct}% / 最大 ${cpuMaxPct}%（${samples.length} 回の計測）`,
      itemKeys: ['cpuAvgPct'],
    },
  };
  return {
    metricId: 'server-process',
    status: 'ok',
    value: rssMaxMb,
    items: { rssMaxMb, cpuAvgPct },
    findings: rssMaxMb >= SERVER_RSS_ALERT_MB ? { rss: subjects.rss } : {},
    subjects,
    details,
  };
}

/** A failed HTTP call, reduced to something safe to publish (status or error code only). */
export function probeFailureReason(error: unknown, status?: number): string {
  if (status !== undefined) return `HTTP ${status}`;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string' && /^[A-Z_]+$/.test(cause.code)) return cause.code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z]+$/.test(name) ? name : 'error';
}
