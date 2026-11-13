/**
 * [Issue #4308] E2E runs as two shards, each with its own dev webServer, and the required check
 * `E2E Tests` survives as the aggregate of both (the same shape as `Unit Tests (shard N/4)` +
 * `Unit Tests`). One server for the whole suite peaked at 78.4% of its heap (develop push run
 * 43440870882), with the peak at the end: dev-mode compiles accumulate across the run.
 *
 * Pinned here: the shard matrix and the `--shard` argument, the aggregate job and what it
 * requires, the heap probe kept per shard with collision-free artifact names, and that the split
 * left the run settings (heap limit, probe env) of the single job alone. The union of the two
 * shards equalling the whole suite is Playwright's own guarantee; it was checked with
 * `playwright test --list` and is recorded in the commit body (not re-run here: loading
 * playwright.config.ts creates directories under $HOME).
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

const CI_WORKFLOW = path.resolve(__dirname, '../../../../.github/workflows/ci-pr.yml');
const PLAYWRIGHT_CONFIG = path.resolve(__dirname, '../../../../playwright.config.ts');
const SHARDS = 2;

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: unknown;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown[]> };
  steps?: Step[];
}

/** Everything wrong with the E2E jobs of a parsed ci-pr.yml; `[]` when the shard layout holds. */
function e2eShardProblems(workflow: { jobs: Record<string, Job> }): string[] {
  const problems: string[] = [];
  const shardJob = workflow.jobs['test-e2e'];
  if (!shardJob) return ['no test-e2e job'];
  const matrix = shardJob.strategy?.matrix?.shard;
  if (JSON.stringify(matrix) !== JSON.stringify([1, 2])) problems.push(`test-e2e matrix.shard is ${JSON.stringify(matrix)}, not [1, 2]`);
  if (shardJob.strategy?.['fail-fast'] !== false) problems.push('test-e2e must not fail fast (one shard red must not cancel the other)');
  if (shardJob.name !== 'E2E Tests (shard ${{ matrix.shard }}/2)') problems.push(`test-e2e name is ${shardJob.name}`);

  const steps = shardJob.steps ?? [];
  const run = steps.find((s) => s.name === 'Run E2E tests');
  // The shard comes through env so the command carries no `${{` (verify-draft would call it runner-specific).
  if (run?.run?.trim() !== `npm run test:e2e -- --shard="$E2E_SHARD/${SHARDS}"`) problems.push(`Run E2E tests runs ${JSON.stringify(run?.run)}`);
  if (run?.env?.E2E_SHARD !== '${{ matrix.shard }}') problems.push('Run E2E tests does not take E2E_SHARD from the matrix');
  if (run?.env?.NODE_OPTIONS !== '--max-old-space-size=8192') problems.push('Run E2E tests changed the heap limit');
  if (run?.env?.CM_E2E_HEAP_PROBE_DIR !== '${{ runner.temp }}/e2e-heap') problems.push('Run E2E tests lost the heap probe dir');
  if (!steps.some((s) => s.name === 'E2E heap summary' && s.run?.includes('e2e-heap-probe.cjs summarize'))) problems.push('no per-shard heap summary');

  const artifactNames = steps.filter((s) => s.uses?.startsWith('actions/upload-artifact')).map((s) => String(s.with?.name));
  for (const base of ['e2e-heap', 'playwright-report']) {
    if (!artifactNames.includes(`${base}-\${{ matrix.shard }}`)) problems.push(`artifact ${base} is not named per shard (got ${JSON.stringify(artifactNames)})`);
  }

  const aggregate = Object.entries(workflow.jobs).find(([, job]) => job.name === 'E2E Tests');
  if (!aggregate) return [...problems, 'no aggregate job named `E2E Tests` (the required check of main)'];
  const [, agg] = aggregate;
  const needs = Array.isArray(agg.needs) ? agg.needs : [agg.needs];
  if (!needs.includes('test-e2e')) problems.push('the aggregate does not need test-e2e');
  if (agg.if !== 'always()') problems.push('the aggregate must run when a shard fails (if: always())');
  if (typeof agg['timeout-minutes'] !== 'number') problems.push('the aggregate has no timeout-minutes');
  const gate = (agg.steps ?? []).map((s) => s.run ?? '').join('\n');
  if (!gate.includes('test "${RESULT}" = "success"') || agg.steps?.[0]?.env?.RESULT !== '${{ needs.test-e2e.result }}') {
    problems.push('the aggregate does not require needs.test-e2e.result == success');
  }
  return problems;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('E2E shards with one webServer each, aggregated into `E2E Tests` (#4308)', () => {
  it('ci-pr.yml has the shard layout', () => {
    expect(e2eShardProblems(parse(fs.readFileSync(CI_WORKFLOW, 'utf-8')))).toEqual([]);
  });

  it('positive control: the single-job layout before the split is rejected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-shard-4308-'));
    dirs.push(dir);
    const file = path.join(dir, 'ci-pr.yml');
    fs.writeFileSync(
      file,
      [
        'jobs:',
        '  test-e2e:',
        '    name: E2E Tests',
        '    timeout-minutes: 30',
        '    steps:',
        '      - name: Run E2E tests',
        '        run: npm run test:e2e',
        '        env:',
        "          NODE_OPTIONS: '--max-old-space-size=8192'",
        '          CM_E2E_HEAP_PROBE_DIR: ${{ runner.temp }}/e2e-heap',
        '      - name: E2E heap summary',
        '        run: node scripts/ci/e2e-heap-probe.cjs summarize "$RUNNER_TEMP/e2e-heap" || true',
        '      - uses: actions/upload-artifact@v4',
        '        with: { name: e2e-heap }',
        '      - uses: actions/upload-artifact@v4',
        '        with: { name: playwright-report }',
        '',
      ].join('\n')
    );
    const problems = e2eShardProblems(parse(fs.readFileSync(file, 'utf-8')));
    expect(problems.some((p) => p.includes('matrix.shard'))).toBe(true);
    expect(problems.some((p) => p.includes('Run E2E tests runs'))).toBe(true);
    expect(problems.some((p) => p.includes('artifact e2e-heap'))).toBe(true);
  });

  it('negative control: dropping only the aggregate is caught on its own', () => {
    const workflow = parse(fs.readFileSync(CI_WORKFLOW, 'utf-8'));
    delete workflow.jobs['test-e2e-result'];
    expect(e2eShardProblems(workflow)).toEqual(['no aggregate job named `E2E Tests` (the required check of main)']);
  });

  it('the split does not change what runs: retries, workers and the webServer stay as they were', () => {
    const config = fs.readFileSync(PLAYWRIGHT_CONFIG, 'utf-8');
    expect(config).toContain('retries: process.env.CI ? 2 : 0');
    expect(config).toContain('workers: process.env.CI ? 1 : undefined');
    expect(config).toContain("testDir: './tests/e2e'");
    expect(config).toContain("command: 'npm run dev'");
    // Playwright's `shard` in the config would override the CLI's --shard; the split lives in CI only.
    expect(config).not.toMatch(/^\s*shard\s*:/m);
  });
});
