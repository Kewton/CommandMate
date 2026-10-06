/**
 * The `ci-flaky` metric (Issue #3310): how develop's push CI failed over the
 * last {@link CI_FLAKY_WINDOW_DAYS} days, per SHA, workflow, job and attempt —
 * not only the last result (a run that passed on a rerun ends as "success").
 *
 * Pure: the text of `gh run list --json`, `gh run view --attempt <n> --json jobs`
 * and `gh run view --attempt <n> --log-failed` in, a {@link MetricMeasurement}
 * out (the commands run in `scripts/agent-health/metrics-runners.ts`).
 *
 * Each failed job is one of:
 * - `test`: its log names failed tests (`FAIL <file> > <name>`)
 * - `infra`: cancelled / timed out, or it fell over in a set-up step
 *   (checkout, Node, `npm ci`, …) before reaching its tests
 * - `other`: it failed at its own step without naming a test (lint, an
 *   unhandled error after the tests, the aggregate job over the shards)
 *
 * Candidates (first values; tune them after looking at the numbers):
 * - flaky: a test that failed on a SHA whose last attempt passed, or that
 *   failed on {@link CI_FLAKY_REPEAT_MIN_SHAS} or more SHAs. Whether the
 *   commits in between touched the test or its subject is **not** checked.
 * - broken: a test that failed on 2 or more SHAs and in the last attempt of
 *   every SHA since it first failed — a bug, not flakiness; filed apart.
 *
 * The repository is public: nothing of a log line but the test's file and
 * name reaches the output (no paths outside the test file, no env, no error
 * text). A file that is not a test file is dropped.
 */

import { createHash } from 'crypto';
import {
  CI_FLAKY_REPEAT_MIN_SHAS,
  CI_FLAKY_WINDOW_DAYS,
  type MetricFinding,
  type MetricMeasurement,
} from './metrics-types';

export { CI_FLAKY_WINDOW_DAYS };

export interface CiRun {
  id: number;
  sha: string;
  workflow: string;
  /** The latest attempt (`gh run list` shows one row per run). */
  attempt: number;
  /** Conclusion of the latest attempt. */
  conclusion: string;
  createdAt: string;
}

export interface CiJob {
  name: string;
  conclusion: string;
  steps: Array<{ name: string; conclusion: string }>;
}

/** One attempt the runner read. `failedLog` is null when nothing failed (the log is not fetched). */
export interface CiAttempt {
  runId: number;
  attempt: number;
  jobs: CiJob[];
  failedLog: string | null;
}

export type CiFailureKind = 'test' | 'infra' | 'other';

/** One failed job of one attempt (`details` is flat, so these go to `records`). */
export type CiFailureRecord = {
  sha: string;
  workflow: string;
  runId: number;
  attempt: number;
  job: string;
  kind: CiFailureKind;
  conclusion: string;
  /** `<file> > <name>`, only for `test`. */
  tests: string[];
};

export type CiFlakyMeasurement =
  | (Omit<Extract<MetricMeasurement, { status: 'ok' }>, 'records'> & { records: CiFailureRecord[] })
  | Extract<MetricMeasurement, { status: 'skip' }>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Job conclusions that are failures; `success`, `skipped` and `neutral` are not. */
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);
const INFRA_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure', 'stale']);
/** Steps that prepare a job; failing in one means the job never reached its own work. */
const SETUP_STEP = /^(?:Set up job|Initialize containers|Checkout|Set ?up\b|Install\b|Cache\b|Resolve\b|Download\b)/i;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
/** `<BOM?><ISO time> ` at the start of each log text. */
const LOG_TIME = /^﻿?\d{4}-\d{2}-\d{2}T[0-9:.]+Z ?/;
const FAIL_LINE = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+?))?\s*(?:\[[^\]]*\])?\s*$/;
const TEST_FILE = /^[A-Za-z0-9_@.\-/]{1,200}\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SAFE_JOB = /^[^\x00-\x1f]{1,120}$/;
export const WHOLE_FILE = '(ファイル全体)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ciFlakyWindowStart(now: Date): number {
  return now.getTime() - CI_FLAKY_WINDOW_DAYS * DAY_MS;
}

/** `gh run list --json databaseId,headSha,attempt,conclusion,status,workflowName,createdAt`: the completed runs in the window. */
export function parseCiRunList(text: string, now: Date): CiRun[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const since = ciFlakyWindowStart(now);
  const runs: CiRun[] = [];
  for (const row of json) {
    if (!isRecord(row)) continue;
    const { databaseId, headSha, attempt, conclusion, status, workflowName, createdAt } = row;
    if (typeof databaseId !== 'number' || typeof headSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(headSha)) continue;
    if (typeof attempt !== 'number' || attempt < 1 || typeof conclusion !== 'string' || status !== 'completed') continue;
    if (typeof workflowName !== 'string' || !SAFE_JOB.test(workflowName) || typeof createdAt !== 'string') continue;
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created) || created < since || created > now.getTime()) continue;
    runs.push({ id: databaseId, sha: headSha, workflow: workflowName, attempt, conclusion, createdAt });
  }
  return runs;
}

/** Runs whose attempts must be read: one that did not pass, or that was rerun. */
export function runsNeedingAttempts(runs: readonly CiRun[]): CiRun[] {
  return runs.filter((run) => run.conclusion !== 'success' || run.attempt > 1);
}

/** `gh run view <id> --attempt <n> --json jobs`; null when malformed. */
export function parseCiJobs(text: string): CiJob[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json.jobs)) return null;
  const jobs: CiJob[] = [];
  for (const job of json.jobs) {
    if (!isRecord(job) || typeof job.name !== 'string' || !SAFE_JOB.test(job.name)) continue;
    const steps = Array.isArray(job.steps)
      ? job.steps.flatMap((step) =>
          isRecord(step) && typeof step.name === 'string'
            ? [{ name: step.name, conclusion: typeof step.conclusion === 'string' ? step.conclusion : '' }]
            : []
        )
      : [];
    jobs.push({ name: job.name, conclusion: typeof job.conclusion === 'string' ? job.conclusion : '', steps });
  }
  return jobs;
}

export function attemptFailed(jobs: readonly CiJob[]): boolean {
  return jobs.some((job) => FAILED.has(job.conclusion));
}

function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * `--log-failed` text (`<job>\t<step>\t<time> <text>` lines) → the failed
 * tests of each job, as `<file> > <name>` (in order, without repeats).
 */
export function parseFailedTests(log: string): Record<string, string[]> {
  const byJob: Record<string, string[]> = {};
  for (const line of log.split('\n')) {
    const first = line.indexOf('\t');
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1);
    if (second < 0) continue;
    const job = line.slice(0, first);
    const text = line.slice(second + 1).replace(ANSI, '').replace(LOG_TIME, '');
    const match = FAIL_LINE.exec(text);
    if (!match || !TEST_FILE.test(match[1]) || !SAFE_JOB.test(job)) continue;
    const name = match[2] === undefined ? WHOLE_FILE : cleanName(match[2]);
    if (name === '') continue;
    const id = `${match[1]} > ${name}`;
    const tests = (byJob[job] ??= []);
    if (!tests.includes(id)) tests.push(id);
  }
  return byJob;
}

/** null when the job did not fail. */
export function classifyCiJob(job: CiJob, failedTests: number): CiFailureKind | null {
  if (!FAILED.has(job.conclusion)) return null;
  if (failedTests > 0) return 'test';
  if (INFRA_CONCLUSIONS.has(job.conclusion)) return 'infra';
  const failedStep = job.steps.find((step) => FAILED.has(step.conclusion));
  if (failedStep === undefined || SETUP_STEP.test(failedStep.name)) return 'infra';
  return 'other';
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/** `<file>:<hash of "file > name">` — stable, without spaces or `-->`. */
export function testTarget(test: string): string {
  return `${test.slice(0, test.indexOf(' > '))}:${shortHash(test)}`;
}

function shorten(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface TestHistory {
  failures: number;
  /** SHAs it failed on, oldest first. */
  shas: string[];
  /** Failures on a SHA whose last attempt passed. */
  passedOnRerun: number;
  jobs: Set<string>;
  workflow: string;
}

interface ShaOutcome {
  sha: string;
  workflow: string;
  firstAt: number;
  /** Attempts in order (run created, then attempt), each passed or not; unknown attempts are left out. */
  attempts: Array<{ passed: boolean; tests: Set<string> }>;
}

interface Collected {
  records: CiFailureRecord[];
  outcomes: Map<string, ShaOutcome>;
  counts: { test: number; infra: number; other: number };
  failedAttempts: number;
  failedTests: number;
  attemptsNotRead: number;
}

/** Reads each attempt of each run: the failed jobs (records, counts) and the outcome per SHA. */
function collectOutcomes(runs: readonly CiRun[], attempts: readonly CiAttempt[]): Collected {
  const read = new Map(attempts.map((a) => [`${a.runId}:${a.attempt}`, a]));
  const ordered = [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  const records: CiFailureRecord[] = [];
  const outcomes = new Map<string, ShaOutcome>();
  const counts = { test: 0, infra: 0, other: 0 };
  let failedAttempts = 0;
  let failedTests = 0;
  let attemptsNotRead = 0;

  for (const run of ordered) {
    const key = `${run.workflow}\n${run.sha}`;
    const outcome = outcomes.get(key) ?? { sha: run.sha, workflow: run.workflow, firstAt: Date.parse(run.createdAt), attempts: [] };
    outcomes.set(key, outcome);
    for (let n = 1; n <= run.attempt; n++) {
      const attempt = read.get(`${run.id}:${n}`);
      if (attempt === undefined) {
        if (n === run.attempt) outcome.attempts.push({ passed: run.conclusion === 'success', tests: new Set() });
        if (n < run.attempt || run.conclusion !== 'success') attemptsNotRead++;
        continue;
      }
      const failed = attemptFailed(attempt.jobs);
      const testsByJob = attempt.failedLog === null ? {} : parseFailedTests(attempt.failedLog);
      const tests = new Set<string>();
      if (failed) failedAttempts++;
      for (const job of attempt.jobs) {
        const jobTests = testsByJob[job.name] ?? [];
        const kind = classifyCiJob(job, jobTests.length);
        if (kind === null) continue;
        counts[kind]++;
        if (kind === 'test') {
          failedTests += jobTests.length;
          for (const test of jobTests) tests.add(test);
        }
        records.push({
          sha: run.sha,
          workflow: run.workflow,
          runId: run.id,
          attempt: n,
          job: job.name,
          kind,
          conclusion: job.conclusion,
          tests: kind === 'test' ? jobTests : [],
        });
      }
      outcome.attempts.push({ passed: !failed, tests });
    }
  }
  return { records, outcomes, counts, failedAttempts, failedTests, attemptsNotRead };
}

/** The history of each failed test over the SHAs (oldest first), and how many SHAs passed on a rerun. */
function buildHistories(
  outcomes: Map<string, ShaOutcome>,
  records: readonly CiFailureRecord[]
): { histories: Map<string, TestHistory>; shaOrder: ShaOutcome[]; retrySuccesses: number } {
  const histories = new Map<string, TestHistory>();
  let retrySuccesses = 0;
  const shaOrder = [...outcomes.values()].sort((a, b) => a.firstAt - b.firstAt);
  for (const outcome of shaOrder) {
    const last = outcome.attempts[outcome.attempts.length - 1];
    const passedOnRerun = last !== undefined && last.passed && outcome.attempts.some((a) => !a.passed);
    if (passedOnRerun) retrySuccesses++;
    for (const attempt of outcome.attempts) {
      for (const test of attempt.tests) {
        const history = histories.get(test) ?? { failures: 0, shas: [], passedOnRerun: 0, jobs: new Set(), workflow: outcome.workflow };
        histories.set(test, history);
        history.failures++;
        if (!history.shas.includes(outcome.sha)) history.shas.push(outcome.sha);
        if (passedOnRerun) history.passedOnRerun++;
      }
    }
  }
  for (const record of records) {
    for (const test of record.tests) histories.get(test)?.jobs.add(record.job);
  }
  return { histories, shaOrder, retrySuccesses };
}

/** Failed in the last attempt of every SHA (of its workflow) since it first failed. */
function failsEverySince(test: string, history: TestHistory, shaOrder: readonly ShaOutcome[]): boolean {
  const same = shaOrder.filter((o) => o.workflow === history.workflow);
  const start = same.findIndex((o) => o.sha === history.shas[0]);
  return same.slice(start).every((o) => o.attempts[o.attempts.length - 1]?.tests.has(test) === true);
}

function buildFinding(test: string, history: TestHistory, isBroken: boolean): MetricFinding {
  const kind = isBroken ? 'broken' : 'flaky';
  const target = testTarget(test);
  const shas = history.shas.slice(0, 5).map((sha) => sha.slice(0, 7)).join(', ');
  const rerun = history.passedOnRerun > 0 ? `／やり直しで成功 ${history.passedOnRerun} 回` : '';
  const unchecked = !isBroken && history.passedOnRerun === 0 ? '（間のコミットがテストと対象を変えたかは見ていない）' : '';
  return {
    target,
    title: isBroken
      ? `fix: 落ち続けるテスト ${shorten(test)} を直す（${history.shas.length} コミット続けて失敗）`
      : `test: 不安定なテスト ${shorten(test)} を直す（${CI_FLAKY_WINDOW_DAYS} 日で失敗 ${history.failures} 回）`,
    evidence: `${test}: 直近 ${CI_FLAKY_WINDOW_DAYS} 日の develop push で失敗 ${history.failures} 回（SHA ${history.shas.length} 個: ${shas}${rerun}）／ジョブ: ${[...history.jobs].join(', ')}${unchecked}`,
    itemKeys: [`${kind}:${target}`],
  };
}

/** Flaky / broken candidates: `items` and `findings` by test, and the two counts. */
function selectCandidates(
  histories: Map<string, TestHistory>,
  shaOrder: readonly ShaOutcome[]
): { items: Record<string, number>; findings: Record<string, MetricFinding>; flaky: number; broken: number } {
  const items: Record<string, number> = {};
  const findings: Record<string, MetricFinding> = {};
  let flaky = 0;
  let broken = 0;
  for (const [test, history] of [...histories].sort(([a], [b]) => a.localeCompare(b))) {
    const repeated = history.shas.length >= CI_FLAKY_REPEAT_MIN_SHAS;
    const isBroken = history.passedOnRerun === 0 && repeated && failsEverySince(test, history, shaOrder);
    if (!isBroken && history.passedOnRerun === 0 && !repeated) continue;
    const kind = isBroken ? 'broken' : 'flaky';
    if (isBroken) broken++;
    else flaky++;
    const finding = buildFinding(test, history, isBroken);
    items[`${kind}:${finding.target}`] = history.failures;
    findings[finding.target] = finding;
  }
  return { items, findings, flaky, broken };
}

/**
 * The measurement. `value` is the number of flaky tests; the counts of the
 * three kinds are in `details`, each failed job of each attempt in `records`.
 */
export function measureCiFlaky(runs: readonly CiRun[], attempts: readonly CiAttempt[], now: Date): CiFlakyMeasurement {
  const { records, outcomes, counts, failedAttempts, failedTests, attemptsNotRead } = collectOutcomes(runs, attempts);
  const { histories, shaOrder, retrySuccesses } = buildHistories(outcomes, records);
  const { items, findings, flaky, broken } = selectCandidates(histories, shaOrder);

  return {
    metricId: 'ci-flaky',
    status: 'ok',
    value: flaky,
    items,
    findings,
    details: {
      windowDays: CI_FLAKY_WINDOW_DAYS,
      since: new Date(ciFlakyWindowStart(now)).toISOString(),
      runs: runs.length,
      failedAttempts,
      testFailures: counts.test,
      failedTests,
      infraFailures: counts.infra,
      otherFailures: counts.other,
      retrySuccesses,
      flakyTests: flaky,
      brokenTests: broken,
      attemptsNotRead,
    },
    records,
  };
}

/** One line for `summary`. */
export function ciFlakySummary(details: Record<string, number | string | null> | undefined): string {
  const n = (key: string) => details?.[key] ?? 0;
  return `直近 ${n('windowDays')} 日 ${n('runs')} run: テストの失敗 ${n('testFailures')}・実行環境の障害 ${n('infraFailures')}・その他 ${n('otherFailures')}・やり直しでの成功 ${n('retrySuccesses')}、不安定 ${n('flakyTests')} 本・落ち続け ${n('brokenTests')} 本`;
}
