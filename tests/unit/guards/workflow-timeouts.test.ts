/**
 * Every GitHub Actions job must declare `timeout-minutes` (Issue #1830).
 *
 * ## What happened
 *
 * GitHub's default job timeout is **360 minutes**. On 2026-08-19 the `E2E Tests`
 * job of run `32218070769` (develop, post-merge) stalled inside
 * `Install Playwright browser` — `npx playwright install --with-deps chromium` —
 * and stayed there for **88 minutes** until a human noticed it in the Actions tab
 * and cancelled it by hand. `gh run rerun --failed` then went green in 6m47s, so
 * nothing was actually broken: the CDN had a bad minute. The other 10 jobs of
 * that run had all finished inside 12 minutes.
 *
 * Nothing in the repository would have stopped that run before the six-hour
 * default, because at the time three of the four workflows declared
 * `timeout-minutes` exactly zero times.
 *
 * ## Why a test rather than a comment
 *
 * The values themselves are documented where they are used, with the measured
 * median/max behind each one. What a comment cannot do is survive the next job
 * being added. A workflow with 10 capped jobs and 1 uncapped one reads as
 * "handled" at a glance and still leaves a six-hour hole; that is the exact
 * shape of regression this file exists to catch.
 *
 * ## What is asserted
 *
 * 1. Every job in every workflow has a `timeout-minutes`.
 * 2. It is a plain positive integer strictly below GitHub's 360-minute default —
 *    a cap at or above the default is a cap that changes nothing.
 * 3. No step-level `timeout-minutes` is >= its job's, which would be dead
 *    configuration: the job cap always fires first.
 * 4. Steps that shell out to a package manager or system installer — the
 *    network-bound work, and the category the #1830 hang came from — carry
 *    their own step-level cap, so a timed-out job says *which* step stalled.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows');

/** GitHub's default job timeout, in minutes. A cap at this value is a no-op. */
const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360;

/**
 * Steps whose `run:` reaches the network for bytes we asked for.
 *
 * Deliberately narrow. `npm run <script>` is not here even though a script may
 * happen to fetch something, and neither are the first-party GitHub actions
 * (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`): those
 * retry internally, run against GitHub's own infrastructure, and have never been
 * the step that hung. Requiring a cap on those would be noise, and noise is how
 * a guard gets switched off.
 *
 * `npm install` matches the bare form only, so `--no-audit` style flags on other
 * commands cannot drag an unrelated step in here.
 */
const NETWORK_INSTALLER_PATTERNS: readonly RegExp[] = [
  /\bnpm\s+ci\b/,
  /\bnpm\s+(?:i|install)\s+(?!run\b)/,
  /\bnpm\s+audit\b/,
  /\bnpm\s+publish\b/,
  /\bnpx\s+playwright\s+install\b/,
  /\bapt-get\s+install\b/,
];

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  'timeout-minutes'?: unknown;
}

interface WorkflowJob {
  name?: string;
  steps?: WorkflowStep[];
  'timeout-minutes'?: unknown;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();
}

function readWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8')) as Workflow;
}

/** Every (file, jobId, job) triple across all workflows. */
function allJobs(): Array<{ file: string; jobId: string; job: WorkflowJob }> {
  return workflowFiles().flatMap((file) =>
    Object.entries(readWorkflow(file).jobs ?? {}).map(([jobId, job]) => ({ file, jobId, job }))
  );
}

function stepLabel(step: WorkflowStep, index: number): string {
  return step.name ?? step.uses ?? `step #${index + 1}`;
}

describe('.github/workflows: timeout-minutes (Issue #1830)', () => {
  // Anti-vacuity: if the glob, the directory or the parser ever returns nothing,
  // every assertion below passes over an empty list. These two fail loudly
  // instead. The floor is well under the real counts (4 files / 14 jobs at the
  // time of writing) so adding or removing a workflow does not touch it.
  it('finds the workflow files it is supposed to be guarding', () => {
    expect(workflowFiles().length).toBeGreaterThanOrEqual(4);
  });

  it('finds jobs inside them', () => {
    expect(allJobs().length).toBeGreaterThanOrEqual(14);
  });

  it('declares timeout-minutes on every job', () => {
    const missing = allJobs()
      .filter(({ job }) => job['timeout-minutes'] === undefined)
      .map(({ file, jobId }) => `${file}: ${jobId}`);

    expect(
      missing,
      'These jobs would hold a runner for GitHub’s 6-hour default if they hung. ' +
        'Add `timeout-minutes:` with the measured median/max behind it — see the ' +
        'header of .github/workflows/ci-pr.yml.'
    ).toEqual([]);
  });

  it('uses a positive integer below the 360-minute default on every job', () => {
    const bad = allJobs()
      .map(({ file, jobId, job }) => ({ file, jobId, value: job['timeout-minutes'] }))
      .filter(
        ({ value }) =>
          !Number.isInteger(value) ||
          (value as number) < 1 ||
          (value as number) >= GITHUB_DEFAULT_TIMEOUT_MINUTES
      )
      .map(({ file, jobId, value }) => `${file}: ${jobId} = ${JSON.stringify(value)}`);

    expect(
      bad,
      `A timeout-minutes of ${GITHUB_DEFAULT_TIMEOUT_MINUTES} or more is the default already, so it caps nothing.`
    ).toEqual([]);
  });

  it('keeps every step-level timeout below its job timeout', () => {
    const dead: string[] = [];

    for (const { file, jobId, job } of allJobs()) {
      const jobTimeout = job['timeout-minutes'];
      if (!Number.isInteger(jobTimeout)) continue;

      (job.steps ?? []).forEach((step, index) => {
        const stepTimeout = step['timeout-minutes'];
        if (!Number.isInteger(stepTimeout)) return;
        if ((stepTimeout as number) >= (jobTimeout as number)) {
          dead.push(
            `${file}: ${jobId} / ${stepLabel(step, index)} = ${stepTimeout} >= job ${jobTimeout}`
          );
        }
      });
    }

    expect(
      dead,
      'The job cap fires first, so these step caps can never fire and the log will not say which step stalled.'
    ).toEqual([]);
  });

  it('caps every step that shells out to a package manager or system installer', () => {
    const uncapped: string[] = [];

    for (const { file, jobId, job } of allJobs()) {
      (job.steps ?? []).forEach((step, index) => {
        const run = step.run;
        if (typeof run !== 'string') return;
        if (!NETWORK_INSTALLER_PATTERNS.some((pattern) => pattern.test(run))) return;
        if (step['timeout-minutes'] !== undefined) return;
        uncapped.push(`${file}: ${jobId} / ${stepLabel(step, index)}`);
      });
    }

    expect(
      uncapped,
      'Issue #1830 hung inside `npx playwright install`. Give network-bound install steps ' +
        'their own timeout-minutes so a timed-out job names the step that stalled.'
    ).toEqual([]);
  });
});
