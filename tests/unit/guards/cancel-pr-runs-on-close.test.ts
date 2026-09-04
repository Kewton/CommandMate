/**
 * The merge-time PR-run canceller can only ever reach the PR's own runs
 * (Issue #2330).
 *
 * ## What it is for
 *
 * `/orchestrate` 6-2 merges a PR before its own CI run finishes, on purpose —
 * the develop push run is the safety net. Measured 2026-09-05 over the last 200
 * merged PRs, 44 of them (22.0%) left the final head's `pull_request` run in
 * flight at merge time, median 23.3 minutes past the merge, and the tail was far
 * worse: #2202..#2209 sat queued for 9-14 hours before somebody cancelled them
 * by hand. One such run is 12 jobs, 11 of them on our self-hosted runners.
 * `.github/workflows/cancel-pr-runs-on-close.yml` stops them at merge/close.
 *
 * ## Why a test rather than a comment
 *
 * The danger of this workflow is not that it fails — it is that it succeeds at
 * cancelling the WRONG run. The develop / main **push** runs are the safety net
 * 6-2 leans on and the only evidence of which merge broke develop; a workflow
 * that reaches them turns the safety net off silently, and the failure looks
 * like "CI is flaky" months later. Three single-token edits get you there:
 * dropping `--event pull_request`, hard-coding a branch, or widening the
 * `--workflow` filter. None of them fails any other gate in this repository, so
 * the containment is asserted here, structurally, as a property of the file.
 *
 * The second thing pinned is that no attacker-controlled text reaches the shell
 * by textual substitution. `${{ }}` inside a `run:` body is exactly that, and a
 * fork PR's head ref is text somebody else chose.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const WORKFLOW_PATH = join(
  process.cwd(),
  '.github',
  'workflows',
  'cancel-pr-runs-on-close.yml'
);

/**
 * The CI workflow whose runs may be cancelled — and the only one. `publish.yml`
 * releases to npm, `pages.yml` deploys the site, `catalog-drift.yml` owns the
 * tracking issue; cancelling any of those mid-flight leaves real state
 * half-written, and none of them is what 6-2 declines to wait for.
 */
const CANCELLABLE_WORKFLOW = 'ci-pr.yml';

/**
 * `gh run list --status` values, from `gh run list --help` (gh 2.86.0). A typo
 * here is not a no-op: `gh` rejects the value, and under `set -euo pipefail`
 * that fails the whole step, so every run on every closed PR would go red.
 */
const GH_RUN_STATUSES: readonly string[] = [
  'queued',
  'completed',
  'in_progress',
  'requested',
  'waiting',
  'pending',
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
];

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface Job {
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: unknown;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const source = readFileSync(WORKFLOW_PATH, 'utf-8');
const workflow = parse(source) as Workflow;

/**
 * `on:` survives YAML 1.1's boolean keys. `yaml`'s default schema parses the
 * bare key `on` as the string "on", but a version or schema change flipping it
 * to `true` would make every trigger assertion below read `undefined` and pass
 * vacuously.
 */
function triggers(): Record<string, unknown> {
  const record = workflow as unknown as Record<string, unknown>;
  const value = (record.on ?? record.true) as Record<string, unknown> | undefined;
  expect(value, '`on:` did not parse — the trigger assertions would be vacuous').toBeDefined();
  return value as Record<string, unknown>;
}

function theJob(): Job {
  const jobs = Object.values(workflow.jobs ?? {});
  expect(jobs, 'the workflow must declare exactly one job').toHaveLength(1);
  return jobs[0];
}

function cancelStep(): Step {
  const steps = theJob().steps ?? [];
  expect(steps, 'the job must declare exactly one step').toHaveLength(1);
  return steps[0];
}

function runBody(): string {
  const body = cancelStep().run;
  expect(typeof body, 'the step must carry a `run:` body').toBe('string');
  // Anti-vacuity: every `expect(body).toContain(...)` below is trivially
  // satisfiable by nothing at all if this file ever stops parsing.
  expect((body as string).length).toBeGreaterThan(200);
  return body as string;
}

describe('.github/workflows/cancel-pr-runs-on-close.yml (Issue #2330)', () => {
  describe('fires on the PR closing, and on nothing else', () => {
    it('declares `pull_request` with `types: [closed]` as its only trigger', () => {
      expect(Object.keys(triggers())).toEqual(['pull_request']);
      expect((triggers().pull_request as { types?: string[] }).types).toEqual(['closed']);
    });

    it('never subscribes to `push`, which is the event the safety net runs on', () => {
      expect(Object.keys(triggers())).not.toContain('push');
    });
  });

  describe('containment: it can only reach the closed PR’s own runs', () => {
    it('filters to `--event pull_request`, so `push` runs are unreachable', () => {
      // This is the load-bearing filter. Verified against the live API on
      // 2026-09-05: `--event push --branch develop` returned an in-progress run
      // (33892933180) that `--event pull_request --branch develop` did not list,
      // even though both name the same branch — which is why a release PR whose
      // head ref *is* `develop` still cannot reach the develop push runs.
      expect(runBody()).toContain('--event pull_request');
      expect(runBody()).not.toContain('--event push');
    });

    it('scopes every listing to the head ref of the PR that just closed', () => {
      const branchArgs = runBody().match(/--branch\s+\S+/g) ?? [];
      expect(branchArgs.length, 'expected at least one `--branch` filter').toBeGreaterThan(0);
      // The only branch this may name is the one the event handed it. A literal
      // `--branch develop` would cancel the safety net by name.
      expect(branchArgs).toEqual(branchArgs.map(() => '--branch "$HEAD_REF"'));
    });

    it(`only ever cancels runs of ${CANCELLABLE_WORKFLOW}`, () => {
      const workflowArgs = runBody().match(/--workflow\s+\S+/g) ?? [];
      expect(workflowArgs.length, 'expected a `--workflow` filter').toBeGreaterThan(0);
      expect(workflowArgs).toEqual(workflowArgs.map(() => `--workflow ${CANCELLABLE_WORKFLOW}`));
    });

    it('cancels by id and never by a bulk selector', () => {
      const cancels = runBody().match(/gh run cancel[^\n]*/g) ?? [];
      expect(cancels.length, 'expected a `gh run cancel` call').toBeGreaterThan(0);
      for (const call of cancels) {
        expect(call).toMatch(/"\$id"/);
        expect(call).not.toMatch(/--branch|--workflow|--event/);
      }
    });
  });

  describe('the `--status` values are ones gh actually accepts', () => {
    it('uses only documented statuses, and only in-flight ones', () => {
      const used = (runBody().match(/for status in ([^;\n]*);\s*do\b/) ?? [])[1];
      expect(used, 'expected the status loop the listing iterates').toBeDefined();
      const values = used.trim().split(/\s+/);
      expect(values.length).toBeGreaterThanOrEqual(2);
      for (const value of values) {
        // An undocumented value is rejected by gh, and `set -e` then reddens
        // every closed PR.
        expect(GH_RUN_STATUSES, `\`${value}\` is not a gh run status`).toContain(value);
        // A terminal status would mean asking gh for runs that cannot be
        // cancelled — dead configuration that reads as extra coverage.
        expect(['completed', 'success', 'failure', 'cancelled', 'skipped', 'timed_out']).not.toContain(
          value
        );
      }
    });
  });

  describe('safety of the job itself', () => {
    it('skips fork PRs, whose token is read-only', () => {
      const condition = theJob().if ?? '';
      expect(condition).toContain('github.event.pull_request.head.repo.full_name');
      expect(condition).toContain('github.repository');
      expect(condition).toMatch(/==/);
    });

    it('runs on a hosted runner, not on the capacity it is trying to free', () => {
      expect(theJob()['runs-on']).toBe('ubuntu-latest');
    });

    it('requests `actions: write` and nothing that could change the repository', () => {
      const permissions = workflow.permissions ?? {};
      expect(permissions.actions).toBe('write');
      expect(permissions.contents ?? 'read').toBe('read');
      for (const [scope, level] of Object.entries(permissions)) {
        if (scope === 'actions') continue;
        expect(level, `\`${scope}\` should not be writable here`).not.toBe('write');
      }
    });

    it('caps the job well below the 6-hour default (Issue #1830)', () => {
      const timeout = theJob()['timeout-minutes'];
      expect(Number.isInteger(timeout)).toBe(true);
      expect(timeout as number).toBeGreaterThan(0);
      expect(timeout as number).toBeLessThanOrEqual(15);
    });
  });

  describe('no attacker-controlled text reaches the shell by substitution', () => {
    it('passes the head ref and PR number through `env:`', () => {
      const env = cancelStep().env ?? {};
      expect(env.HEAD_REF).toBe('${{ github.event.pull_request.head.ref }}');
      expect(env.PR_NUMBER).toBe('${{ github.event.pull_request.number }}');
      expect(env.GH_TOKEN).toBe('${{ github.token }}');
    });

    it('carries no `${{ }}` expression inside the `run:` body', () => {
      // A branch name may contain `$`, a backtick or a `;`. `${{ }}` in a `run:`
      // is textual substitution performed before bash sees the script, so the
      // quoting in the script cannot save it. Dry-run 2026-09-05 with
      // HEAD_REF=`feature/x; echo PWNED > /tmp/pwned; #\`whoami\`$(id)` reached
      // `gh` as one argv element and executed nothing.
      expect(runBody()).not.toMatch(/\$\{\{/);
    });

    it('runs under `set -euo pipefail`, so a failed listing cannot read as “nothing to cancel”', () => {
      expect(runBody()).toMatch(/set -euo pipefail/);
    });
  });
});
