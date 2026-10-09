/**
 * Every CI step either has a local gate or a written reason not to (Issue #3478).
 *
 * ## What happened
 *
 * PR #3405 (#3312) passed the local checks — ESLint, tsc, 2817 related tests —
 * and the contract's gates (lint / typecheck / unit-related / integration), and
 * then went red in CI's Lint job on shellcheck (SC2034 / SC1091 / SC2174).
 * `npm run lint:sh` is the second step of that job, and neither `npm run lint`
 * nor any gate in `.commandmate/verify.yaml` ran it. One re-instruction to the
 * worker and one CI round (about 40 minutes) paid for that gap.
 *
 * The earlier guards compare one CI job with one gate at a time
 * (`static-guard-single-source.test.ts`, `verify-build-integration-gates.test.ts`).
 * None of them enumerates CI, so a step that no one thought to pair — the
 * shellcheck step — was invisible to all of them.
 *
 * ## What this pins
 *
 * Every `run:` step of `.github/workflows/ci-pr.yml` is in exactly one of two
 * lists below:
 *
 *   COVERED  — a verify gate runs the same check. The gate's command is the CI
 *              command itself, or (for `lint-sh`) a script that runs it.
 *   EXCLUDED — deliberately not a local check, with the reason.
 *
 * A step added to CI with neither fails here, naming the step. Entries that no
 * longer match a CI step fail too, so the lists cannot rot into fiction.
 *
 * The local side is `.commandmate/verify.yaml`: it is what `wait --verify` and
 * `commandmate verify` run, and the contract template of
 * `.claude/commands/orchestrate.md` (2-4) selects from it.
 *
 * `uses:` steps (checkout, setup-node, cache, upload-artifact) are not checks
 * and are not enumerated. A future check shipped as an action rather than a
 * `run:` would slip past this file; add it here by hand if that ever happens.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { loadVerifyConfig } from '@/lib/verification/verify-config';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci-pr.yml');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as Workflow;
const config = loadVerifyConfig(REPO_ROOT);

/** `<job id> › <step name>` — the same thing the Actions tab shows. */
const stepKey = (jobId: string, step: WorkflowStep): string => `${jobId} › ${step.name ?? '(unnamed)'}`;

const ciRunSteps = Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
  (job.steps ?? [])
    .filter((step): step is WorkflowStep & { run: string } => typeof step.run === 'string')
    .map((step) => ({ key: stepKey(jobId, step), jobId, step }))
);

/**
 * CI step → the verify gate that runs the same check locally.
 *
 * `ciCommand` must appear in the step's `run:`. The gate runs `ciCommand`
 * verbatim, unless `via` names the script that runs it on the gate's behalf.
 */
const COVERED: readonly { key: string; gate: string; ciCommand: string; via?: string }[] = [
  { key: 'claudemd-size › Check CLAUDE.md size', gate: 'claudemd-size', ciCommand: 'node scripts/check-claudemd-size.mjs' },
  { key: 'control-chars › Check for raw control characters in src/', gate: 'control-chars', ciCommand: 'node scripts/check-control-chars.mjs' },
  {
    key: 'token-discipline › Guard raw colors and token existence in migrated directories',
    gate: 'token-discipline',
    ciCommand: 'node scripts/check-token-discipline.mjs',
  },
  { key: 'route-exports › Guard route export shape under src/app', gate: 'route-exports', ciCommand: 'node scripts/check-route-exports.mjs' },
  { key: 'lint › Run ESLint', gate: 'lint', ciCommand: 'npm run lint' },
  // [Issue #3478] The gap PR #3405 fell through. The gate runs `lint:sh` only
  // when the branch touches a `.sh`; see scripts/run-lint-sh-if-changed.mjs.
  { key: 'lint › Shell script lint', gate: 'lint-sh', ciCommand: 'npm run lint:sh', via: 'scripts/run-lint-sh-if-changed.mjs' },
  { key: 'type-check › Run TypeScript type check', gate: 'typecheck', ciCommand: 'npx tsc --noEmit' },
  // CI shards the suite four ways; the gate runs it whole.
  { key: 'test-unit › Run unit tests', gate: 'unit', ciCommand: 'npm run test:unit' },
  { key: 'test-integration › Run integration tests', gate: 'integration', ciCommand: 'npm run test:integration' },
  { key: 'build › Build Next.js', gate: 'build', ciCommand: 'npm run build' },
  { key: 'build › Build CLI', gate: 'build-cli', ciCommand: 'npm run build:cli' },
  { key: 'build › Build server', gate: 'build-server', ciCommand: 'npm run build:server' },
];

/**
 * CI steps that are deliberately NOT local checks, each with its reason.
 *
 * `match` is an exact step key, or a step name that recurs in every job.
 */
const EXCLUDED: readonly { match: { key: string } | { stepName: string }; reason: string }[] = [
  {
    match: { stepName: 'Install dependencies' },
    reason:
      'Setup, not a check. CI starts from an empty runner; a worktree being verified already has node_modules, and a gate that reinstalls would race the other worktrees for the npm cache.',
  },
  {
    match: { key: 'test-unit-result › Require every shard to pass' },
    reason: 'Aggregates the four CI shards into one required check. The `unit` gate is unsharded, so there is nothing to aggregate.',
  },
  {
    match: { key: 'legacy-tmux-readmode › Install tmux' },
    reason: 'legacy-tmux-readmode needs Docker with a pre-3.2 tmux image; the machine running verify may have neither (static-guard-single-source.test.ts NOT_DECLARED).',
  },
  {
    match: { key: 'legacy-tmux-readmode › Assert the tmux under test really predates display-popup' },
    reason: 'Part of legacy-tmux-readmode (Docker-only, see Install tmux).',
  },
  {
    match: { key: 'legacy-tmux-readmode › Bundle the shipped reading-mode modules' },
    reason: 'Part of legacy-tmux-readmode (Docker-only, see Install tmux).',
  },
  {
    match: { key: 'legacy-tmux-readmode › Verify no-op + Plan B against real tmux' },
    reason: 'Part of legacy-tmux-readmode (Docker-only, see Install tmux).',
  },
  {
    match: { key: 'test-e2e › Resolve the installed Playwright version' },
    reason: 'Setup for E2E, which is not a local gate (see Run E2E tests).',
  },
  {
    match: { key: 'test-e2e › Install Playwright system dependencies' },
    reason: 'Setup for E2E (apt packages on the runner), which is not a local gate (see Run E2E tests).',
  },
  {
    match: { key: 'test-e2e › Note degraded system dependencies' },
    reason: 'A CI log annotation about the step above; checks nothing.',
  },
  {
    match: { key: 'test-e2e › Install Playwright browser' },
    reason: 'Setup for E2E, which is not a local gate (see Run E2E tests).',
  },
  {
    match: { key: 'test-e2e › Run E2E tests' },
    reason:
      'Declared gates run on every `wait --verify`; E2E adds 5m+ per worker to every parallel orchestration (verify.yaml comment). Contracts can still name an `e2e` gate when an Issue needs it.',
  },
  {
    match: { key: 'security-audit › Run security audit' },
    reason: 'Posts the dependency tree to the npm registry; a registry outage is not a verdict about the diff (#2313), and the result does not depend on the worker\'s change.',
  },
];

const isExcluded = (key: string, stepName: string | undefined): boolean =>
  EXCLUDED.some(({ match }) => ('key' in match ? match.key === key : match.stepName === stepName));

const gateById = (id: string) => config?.gates.find((gate) => gate.id === id);

describe('CI steps vs local checks (Issue #3478)', () => {
  it('reads a non-trivial CI workflow and verify.yaml', () => {
    // A parse that silently found nothing would make every assertion below vacuous.
    expect(ciRunSteps.length).toBeGreaterThan(20);
    expect(config?.gates.length ?? 0).toBeGreaterThan(5);
  });

  it('lists every CI `run:` step as either covered or excluded with a reason', () => {
    const covered = new Set(COVERED.map((entry) => entry.key));
    const unaccounted = ciRunSteps
      .filter(({ key, step }) => !covered.has(key) && !isExcluded(key, step.name))
      .map(({ key }) => key);
    expect(
      unaccounted,
      'CI has a step that no verify gate runs. Add a gate (and a COVERED entry), or add it to EXCLUDED with the reason it stays CI-only.'
    ).toEqual([]);
  });

  it('never lists a step as both covered and excluded', () => {
    const both = COVERED.filter(({ key }) => {
      const found = ciRunSteps.find((entry) => entry.key === key);
      return isExcluded(key, found?.step.name);
    }).map(({ key }) => key);
    expect(both).toEqual([]);
  });

  it('has no stale entries', () => {
    const keys = new Set(ciRunSteps.map(({ key }) => key));
    const names = new Set(ciRunSteps.map(({ step }) => step.name));
    for (const { key } of COVERED) {
      expect(keys.has(key), `COVERED names a CI step that no longer exists: ${key}`).toBe(true);
    }
    for (const { match } of EXCLUDED) {
      const present = 'key' in match ? keys.has(match.key) : names.has(match.stepName);
      expect(present, `EXCLUDED names a CI step that no longer exists: ${JSON.stringify(match)}`).toBe(true);
    }
  });

  it('gives every exclusion a reason', () => {
    for (const { match, reason } of EXCLUDED) {
      expect(reason.trim().length, `no reason for ${JSON.stringify(match)}`).toBeGreaterThan(20);
    }
  });

  describe.each(COVERED)('$key', ({ key, gate, ciCommand, via }) => {
    it(`CI still runs \`${ciCommand}\``, () => {
      const found = ciRunSteps.find((entry) => entry.key === key);
      expect(found?.step.run).toContain(ciCommand);
    });

    it(`is run locally by the \`${gate}\` gate`, () => {
      const declared = gateById(gate);
      expect(declared, `.commandmate/verify.yaml declares no '${gate}' gate`).toBeDefined();
      if (via === undefined) {
        expect(declared?.command).toBe(ciCommand);
        return;
      }
      expect(declared?.command).toContain(`node ${via}`);
      const npmScript = ciCommand.replace(/^npm run /, '');
      expect(readFileSync(join(REPO_ROOT, via), 'utf-8')).toContain(`'${npmScript}'`);
    });
  });
});
