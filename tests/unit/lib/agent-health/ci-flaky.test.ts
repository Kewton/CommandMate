/**
 * Issue #3310: the `ci-flaky` metric — develop push CI failures per SHA, job
 * and attempt, split into test failures / runner problems / reruns that passed.
 *
 * The fixtures are real `gh` output (Kewton/CommandMate, 2026-09-28〜10-05),
 * trimmed: the run list as is, the jobs without URLs, and from each
 * `--log-failed` only the first line of each job, the `FAIL` lines, the
 * summaries, `##[error]` and a few `npm error` lines.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  CI_FLAKY_WINDOW_DAYS,
  classifyCiJob,
  measureCiFlaky,
  parseCiJobs,
  parseCiRunList,
  parseFailedTests,
  runsNeedingAttempts,
  type CiAttempt,
} from '@/lib/agent-health/ci-flaky';
import { buildQueue, evaluateMetric } from '@/lib/agent-health/metrics-rules';

const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures', 'agent-health-ci-flaky-3310');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const NOW = new Date('2026-10-05T10:00:00.000Z');

/** Every attempt the runner would read, from the fixtures. */
function fixtureAttempts(): CiAttempt[] {
  const runs = parseCiRunList(read('run-list.json'), NOW)!;
  const attempts: CiAttempt[] = [];
  for (const run of runsNeedingAttempts(runs)) {
    for (let attempt = 1; attempt <= run.attempt; attempt++) {
      const jobs = parseCiJobs(read(`jobs-${run.id}-${attempt}.json`))!;
      const logFile = path.join(FIXTURES, `log-${run.id}-${attempt}.txt`);
      attempts.push({
        runId: run.id,
        attempt,
        jobs,
        failedLog: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : null,
      });
    }
  }
  return attempts;
}

function measureFixtures() {
  return measureCiFlaky(parseCiRunList(read('run-list.json'), NOW)!, fixtureAttempts(), NOW);
}

describe('parseCiRunList', () => {
  it('keeps the completed runs of the last 7 days', () => {
    const runs = parseCiRunList(read('run-list.json'), NOW)!;
    expect(CI_FLAKY_WINDOW_DAYS).toBe(7);
    expect(runs.length).toBeGreaterThan(100);
    const since = NOW.getTime() - 7 * 24 * 60 * 60 * 1000;
    expect(runs.every((run) => Date.parse(run.createdAt) >= since)).toBe(true);
  });

  it('drops runs still in progress and malformed rows; null for non-JSON', () => {
    const text = JSON.stringify([
      { databaseId: 1, headSha: 'a'.repeat(40), attempt: 1, conclusion: '', status: 'in_progress', workflowName: 'CI', createdAt: '2026-10-05T09:00:00Z' },
      { databaseId: 2, headSha: 'b'.repeat(40), attempt: 1, conclusion: 'success', status: 'completed', workflowName: 'CI', createdAt: '2026-10-05T09:00:00Z' },
      { databaseId: 'x' },
    ]);
    expect(parseCiRunList(text, NOW)!.map((run) => run.id)).toEqual([2]);
    expect(parseCiRunList('not json', NOW)).toBeNull();
  });

  it('reads the jobs of only the runs that failed or were rerun', () => {
    const runs = parseCiRunList(read('run-list.json'), NOW)!;
    expect(runsNeedingAttempts(runs).map((run) => `${run.id}:${run.attempt}`).sort()).toEqual([
      '36679846941:1',
      '36718862605:2',
      '37142371733:1',
      '37166126909:2',
      '37215224024:1',
      '37240344826:1',
    ]);
  });
});

describe('parseFailedTests', () => {
  it('reads the FAIL lines per job, through the ANSI colours', () => {
    const tests = parseFailedTests(read('log-37215224024-1.txt'));
    expect(tests).toEqual({
      'Unit Tests (shard 2/4)': [
        'tests/unit/guards/no-procfs-env-fixtures.test.ts > no test points an env var into /proc, /sys or /dev > finds nothing under tests/',
      ],
    });
  });

  it('does not take a passing test whose name contains FAIL, nor stdout headers', () => {
    const tests = parseFailedTests(read('log-36718862605-1.txt'));
    expect(Object.keys(tests).sort()).toEqual(['Unit Tests (shard 2/4)', 'Unit Tests (shard 4/4)']);
    expect(JSON.stringify(tests)).not.toContain('stays FAIL');
    expect(JSON.stringify(tests)).not.toContain('renameSession');
  });

  it('a file that failed to load is named by the file', () => {
    const log = 'Unit Tests\tUNKNOWN STEP\t2026-10-04T00:00:00.0000000Z  FAIL  tests/unit/a.test.ts [ tests/unit/a.test.ts ]\n';
    expect(parseFailedTests(log)).toEqual({ 'Unit Tests': ['tests/unit/a.test.ts > (ファイル全体)'] });
  });

  it('ignores a FAIL line that does not name a test file', () => {
    const log = 'Unit Tests\tUNKNOWN STEP\t2026-10-04T00:00:00.0000000Z  FAIL  /home/runner/secret/x > y\n';
    expect(parseFailedTests(log)).toEqual({});
  });
});

describe('classifyCiJob', () => {
  const jobs = (id: string) => parseCiJobs(read(`jobs-${id}.json`))!;
  const job = (id: string, name: string) => jobs(id).find((j) => j.name === name)!;

  it('a job with FAIL lines is a test failure', () => {
    expect(classifyCiJob(job('37215224024-1', 'Unit Tests (shard 2/4)'), 1)).toBe('test');
  });

  it('a job that fell over before its tests, or was cancelled, is the environment', () => {
    expect(classifyCiJob(job('37142371733-1', 'Type Check'), 0)).toBe('infra');
    expect(classifyCiJob(job('36718862605-1', 'Unit Tests (shard 3/4)'), 0)).toBe('infra');
    expect(classifyCiJob(job('36718862605-1', 'E2E Tests'), 0)).toBe('infra');
  });

  it('a job that failed at its own step without naming a test is other', () => {
    // shard 1/4 of 37166126909 ended on an unhandled "window is not defined"; the aggregate job only reads the shards
    expect(classifyCiJob(job('37166126909-1', 'Unit Tests (shard 1/4)'), 0)).toBe('other');
    expect(classifyCiJob(job('37166126909-1', 'Unit Tests'), 0)).toBe('other');
  });

  it('a job that passed is not a failure', () => {
    expect(classifyCiJob(job('37166126909-2', 'Unit Tests (shard 1/4)'), 0)).toBeNull();
  });
});

describe('measureCiFlaky (real develop runs, 2026-09-28〜10-05)', () => {
  it('records each failure per SHA, job and attempt', () => {
    const m = measureFixtures();
    expect(m.status).toBe('ok');
    if (m.status !== 'ok') return;
    expect(m.records).toContainEqual({
      sha: '935a415cb79a78b74b28962ca109fe765d898882',
      workflow: 'CI',
      runId: 37240344826,
      attempt: 1,
      job: 'Unit Tests (shard 3/4)',
      kind: 'test',
      conclusion: 'failure',
      tests: ['tests/unit/tmux-navigation.test.ts > sendSpecialKeysAndInvalidate > should call invalidateCache even after sending multiple keys'],
    });
    expect(m.records).toContainEqual(
      expect.objectContaining({ runId: 37166126909, attempt: 1, job: 'Unit Tests (shard 1/4)', kind: 'other', tests: [] })
    );
    expect(m.records!.every((record) => record.attempt >= 1 && typeof record.sha === 'string')).toBe(true);
  });

  it('the two failures of 2026-10-04 name their two tests', () => {
    const runs = parseCiRunList(read('run-list.json'), NOW)!.filter((run) => [37215224024, 37240344826].includes(run.id));
    const attempts = fixtureAttempts().filter((a) => [37215224024, 37240344826].includes(a.runId));
    const m = measureCiFlaky(runs, attempts, NOW);
    if (m.status !== 'ok') throw new Error('skip');
    const tests = m.records!.flatMap((record) => (record.kind === 'test' ? record.tests : []));
    expect(tests.sort()).toEqual([
      'tests/unit/guards/no-procfs-env-fixtures.test.ts > no test points an env var into /proc, /sys or /dev > finds nothing under tests/',
      'tests/unit/tmux-navigation.test.ts > sendSpecialKeysAndInvalidate > should call invalidateCache even after sending multiple keys',
    ]);
    expect(m.details).toMatchObject({ testFailures: 2, failedTests: 2, retrySuccesses: 0 });
    // once each on one SHA: recorded, not (yet) a candidate
    expect(m.findings).toEqual({});
  });

  it('counts test failures, environment failures and reruns that passed apart', () => {
    const m = measureFixtures();
    if (m.status !== 'ok') throw new Error('skip');
    expect(m.details).toMatchObject({
      windowDays: 7,
      runs: 200,
      failedAttempts: 6,
      // 36718862605#1 shards 2/4 and 4/4, 37215224024, 37240344826
      testFailures: 4,
      // 36679846941 shard 2/4 and 37142371733 Type Check (npm install), 36718862605#1 shard 3/4 (install) and E2E (cancelled)
      infraFailures: 4,
      // the aggregate "Unit Tests" job ×5 and 37166126909#1 shard 1/4 (unhandled error)
      otherFailures: 6,
      retrySuccesses: 2,
    });
  });

  it('a test that failed and then passed on a rerun, or failed on two SHAs, is a flaky candidate', () => {
    const m = measureFixtures();
    if (m.status !== 'ok') throw new Error('skip');
    const titles = Object.values(m.findings).map((f) => f.title);
    expect(titles).toHaveLength(2);
    expect(titles.some((t) => t.includes('no-procfs-env-fixtures.test.ts'))).toBe(true);
    expect(titles.some((t) => t.includes('status-detector-selection.test.ts'))).toBe(true);
    expect(m.value).toBe(2);
    const procfs = Object.values(m.findings).find((f) => f.title.includes('no-procfs'))!;
    expect(procfs.target).toMatch(/^tests\/unit\/guards\/no-procfs-env-fixtures\.test\.ts:[0-9a-f]{8}$/);
    expect(procfs.itemKeys).toEqual([`flaky:${procfs.target}`]);
    expect(procfs.evidence).toContain('失敗 2 回');
    expect(procfs.evidence).toContain('やり直しで成功 1 回');
  });

  it('copies no log text beyond test files and names (paths, env, error messages)', () => {
    const text = JSON.stringify(measureFixtures());
    expect(text).not.toMatch(/\/home\/|npm error|EIDLETIMEOUT|ECONNRESET|RESULT|window is not defined|timed out|\x1b/);
  });
});

describe('measureCiFlaky (synthetic)', () => {
  const sha = (n: number) => String(n).padStart(40, '0');
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  const run = (id: number, attempt: number, conclusion: string, hoursAgo: number) => ({
    id,
    sha: sha(id),
    workflow: 'CI',
    attempt,
    conclusion,
    createdAt: at(hoursAgo),
  });
  const failing = (runId: number, attempt: number, test: string): CiAttempt => ({
    runId,
    attempt,
    jobs: [{ name: 'Unit', conclusion: 'failure', steps: [{ name: 'Install dependencies', conclusion: 'success' }, { name: 'Run unit tests', conclusion: 'failure' }] }],
    failedLog: `Unit\tUNKNOWN STEP\t${at(1)}  FAIL  tests/unit/${test}.test.ts > suite > case\n`,
  });

  it('a test failing on every SHA since it first failed is broken, not flaky', () => {
    const runs = [run(1, 1, 'failure', 30), run(2, 1, 'failure', 20), run(3, 1, 'failure', 10)];
    const m = measureCiFlaky(runs, [failing(1, 1, 'a'), failing(2, 1, 'a'), failing(3, 1, 'a')], NOW);
    if (m.status !== 'ok') throw new Error('skip');
    const [finding] = Object.values(m.findings);
    expect(finding.itemKeys).toEqual([`broken:${finding.target}`]);
    expect(finding.title).toMatch(/^fix: /);
    expect(m.value).toBe(0);
    expect(m.details).toMatchObject({ brokenTests: 1, flakyTests: 0 });
  });

  it('a test failing on two SHAs with a pass in between is flaky', () => {
    const runs = [run(1, 1, 'failure', 30), run(2, 1, 'success', 20), run(3, 1, 'failure', 10)];
    const m = measureCiFlaky(runs, [failing(1, 1, 'a'), failing(3, 1, 'a')], NOW);
    if (m.status !== 'ok') throw new Error('skip');
    const [finding] = Object.values(m.findings);
    expect(finding.itemKeys).toEqual([`flaky:${finding.target}`]);
    expect(finding.evidence).toContain('SHA 2 個');
  });

  it('nothing failed: value 0, no records, no findings', () => {
    const m = measureCiFlaky([run(1, 1, 'success', 5)], [], NOW);
    expect(m).toMatchObject({ status: 'ok', value: 0, findings: {}, items: {}, records: [] });
  });

  it('evaluates like performance: new ones are candidates, persisting ones outstanding; queued after performance', () => {
    const m = measureFixtures();
    const first = evaluateMetric(m, null);
    expect(first).toMatchObject({ metricId: 'ci-flaky', category: 'ci', status: 'fail', candidates: [] });
    expect(first.outstanding).toHaveLength(2);
    expect(first.records!.length).toBeGreaterThan(0);
    expect(first.summary).toContain('テストの失敗 4');
    const second = evaluateMetric(m, { measuredAt: NOW.toISOString(), value: 0, items: {} });
    expect(second.candidates).toHaveLength(2);
    const perf = evaluateMetric(
      { metricId: 'error-rate', status: 'ok', value: 60, items: { 'a:b': 60 }, findings: { 'a:b': { target: 'a:b', title: 't' } }, subjects: { 'a:b': { target: 'a:b', title: 't' } } },
      null
    );
    expect(buildQueue([second, perf]).map((entry) => entry.metricId)).toEqual(['ci-flaky', 'ci-flaky', 'error-rate']);
    expect(buildQueue([first, perf]).map((entry) => `${entry.metricId}:${entry.source}`)).toEqual([
      'error-rate:outstanding',
      'ci-flaky:outstanding',
      'ci-flaky:outstanding',
    ]);
  });
});
