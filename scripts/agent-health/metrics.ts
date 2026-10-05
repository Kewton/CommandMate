/**
 * `npx tsx scripts/agent-health/metrics.ts [--out …] [--state …] [--only …] [--coverage|--no-coverage]`
 *
 * Measures security, maintainability (Issue #3044), performance (Issue #3054) and CI (Issue #3310)
 * metrics without any AI and writes `~/.commandmate/agent-health/metrics/<JST date>.json`. The
 * scheduled AI (docs/agent-health/metrics-prompt.md) files the candidates.
 * See docs/user-guide/agent-health.md "メトリクス計測".
 *
 * Order of a run: parse arguments → take the lock → measure (a pool of 3,
 * within {@link METRICS_BUDGET_SEC}) → compare with the state → write the
 * report, then the state. Exit 0 nothing failed / 1 a metric failed /
 * 2 the script itself went wrong (the report is still written when possible).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMetricsArgs, type MetricsOptions } from '@/lib/agent-health/metrics-args';
import {
  buildQueue,
  decideMetricsExitCode,
  evaluateAll,
  isCoverageDay,
  metricsDateJst,
  nextMetricsState,
  parseMetricsState,
} from '@/lib/agent-health/metrics-rules';
import {
  METRICS_BUDGET_SEC,
  type MetricMeasurement,
  type MetricsReport,
} from '@/lib/agent-health/metrics-types';
import { killActiveCommands, measureAll } from './metrics-runners';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIR = path.join(os.homedir(), '.commandmate', 'agent-health');
/** Kept back from the budget for writing the report. */
const WRITE_RESERVE_MS = 20_000;

function log(message: string): void {
  process.stderr.write(`[agent-health-metrics] ${message}\n`);
}

function commandmateCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(staging, file);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string): string | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = Number.parseInt(readTextIfPresent(lockPath) ?? '', 10);
  if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) {
    return `別のメトリクス計測（pid ${holder}）が進行中（${lockPath}）`;
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return null;
}

function reportOf(startedAt: Date, report: Omit<MetricsReport, 'schemaVersion' | 'startedAt' | 'completedAt' | 'host'>): MetricsReport {
  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    ...report,
    host: { commandmateCommit: commandmateCommit(), node: process.version },
  };
}

function writeReportOrPrint(file: string, report: MetricsReport): boolean {
  try {
    writeJson(file, report);
    log(`report: ${file}`);
    return true;
  } catch (error) {
    log(`could not write the report to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return false;
  }
}

export async function main(argv: readonly string[]): Promise<0 | 1 | 2> {
  const startedAt = new Date();
  const parsed = parseMetricsArgs(argv);
  if (!parsed.ok && parsed.help) {
    process.stdout.write(`${parsed.error}\n`);
    return 0;
  }
  if (!parsed.ok) {
    log(parsed.error);
    return 2;
  }
  return run(parsed.options, startedAt);
}

async function run(options: MetricsOptions, startedAt: Date): Promise<0 | 1 | 2> {
  const outPath = path.resolve(options.out ?? path.join(DEFAULT_DIR, 'metrics', `${metricsDateJst(startedAt)}.json`));
  const statePath = path.resolve(options.statePath ?? path.join(DEFAULT_DIR, 'metrics-state.json'));
  const lockPath = path.join(path.dirname(statePath), 'metrics.lock');
  const scriptErrors: string[] = [];

  const lockError = acquireLock(lockPath);
  if (lockError) {
    log(lockError);
    writeReportOrPrint(outPath, reportOf(startedAt, { metrics: [], queue: [], scriptErrors: [lockError] }));
    return 2;
  }

  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-agent-health-metrics-'));
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    log(`${signal} received — stopping the tools`);
    killActiveCommands();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(lockPath, { force: true });
    process.exit(2);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const state = parseMetricsState(readTextIfPresent(statePath));
  const runCoverage = options.coverage === 'on' || (options.coverage === 'auto' && isCoverageDay(startedAt));
  const selected = options.metrics.filter((id) => id !== 'coverage' || runCoverage);
  const measurements: MetricMeasurement[] = [];
  if (options.metrics.includes('coverage') && !runCoverage) {
    measurements.push({
      metricId: 'coverage',
      status: 'skip',
      reason: options.coverage === 'off' ? '--no-coverage が指定された' : '週 1 回（月曜・JST）だけ計測する',
    });
  }

  try {
    measurements.push(
      ...(await measureAll(
        {
          repoRoot: REPO_ROOT,
          workDir,
          deadline: startedAt.getTime() + METRICS_BUDGET_SEC * 1000 - WRITE_RESERVE_MS,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
          log,
        },
        selected
      ))
    );
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`run aborted: ${message}`);
    scriptErrors.push(message);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const metrics = evaluateAll(measurements, state);
  const report = reportOf(startedAt, {
    metrics,
    queue: buildQueue(metrics),
    ...(scriptErrors.length > 0 ? { scriptErrors } : {}),
  });
  if (!writeReportOrPrint(outPath, report)) scriptErrors.push(`レポートを書けなかった: ${outPath}`);
  try {
    writeJson(statePath, nextMetricsState(state, measurements, startedAt));
  } catch (error) {
    scriptErrors.push(`state を書けなかった: ${error instanceof Error ? error.message : String(error)}`);
  }
  fs.rmSync(lockPath, { force: true });

  for (const metric of metrics) {
    log(`${metric.metricId}=${metric.status} value=${metric.value ?? '-'} candidates=${metric.candidates.length} — ${metric.summary}`);
  }
  const exitCode = scriptErrors.length > 0 ? 2 : decideMetricsExitCode(report);
  log(`exit ${exitCode} in ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`);
  return exitCode;
}

if (require.main === module) {
  void main(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((error: unknown) => {
      process.stderr.write(`[agent-health-metrics] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(2);
    });
}
