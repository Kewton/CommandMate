/**
 * The static guards have exactly one implementation each (Issue #1882).
 *
 * ## What happened
 *
 * PR #1881 landed a commit that `wait --verify` had judged with **exit 0 on
 * every gate**, and CI then failed it on `Token discipline`. The declared gates
 * were `lint` / `typecheck` / `unit` — three of CI's eleven jobs — so the
 * verdict was green about everything it looked at and silent about the rest.
 * `/orchestrate` decides a worker is done from that exit code, which is the
 * whole point of replacing prose self-reports with a number.
 *
 * ## Why a test rather than a comment
 *
 * Closing the gap means running the same check from two places. The tempting
 * way to do that is to paste the `git grep` and the `35000` into
 * `.commandmate/verify.yaml`; then there are two implementations of one rule,
 * and the next person to widen the guarded directory list updates one of them.
 * The failure mode is silent in the direction that matters: verify stays green
 * while CI goes red, which is exactly the accident above.
 *
 * So the invariant is not "both places run a check", it is "both places run the
 * SAME FILE, and neither carries a second copy of the logic". That is what is
 * asserted here.
 *
 * `scripts/check-control-chars.mjs` was already shaped this way before #1882 and
 * is included so the third gate is held to the same rule. `check-route-exports.mjs`
 * (Issue #1946) is the fourth, added for the same reason.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const REPO_ROOT = process.cwd();
const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci-pr.yml');
const VERIFY_CONFIG = join(REPO_ROOT, '.commandmate', 'verify.yaml');

/**
 * The static guards, each as `CI job id` → `the one command that runs it`.
 *
 * The verify gate id is deliberately the CI job id: a `RESULT failed` line and a
 * red check in the Actions tab should name the same thing.
 *
 * `route-exports` joined in #1946. It is here for the same reason as the other
 * three and for one more: the property it checks is only otherwise visible
 * inside `next build`, and there is no build gate, so if its declaration ever
 * drifts between CI and verify the failure mode is the #1943 accident again.
 */
const STATIC_GUARDS = [
  { jobId: 'token-discipline', command: 'node scripts/check-token-discipline.mjs' },
  { jobId: 'control-chars', command: 'node scripts/check-control-chars.mjs' },
  { jobId: 'claudemd-size', command: 'node scripts/check-claudemd-size.mjs' },
  { jobId: 'route-exports', command: 'node scripts/check-route-exports.mjs' },
] as const;

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

interface VerifyGate {
  id: string;
  command: string;
  timeoutSec: number;
}

const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as Workflow;
const verifyConfig = parse(readFileSync(VERIFY_CONFIG, 'utf-8')) as { gates: VerifyGate[] };

/** Every `run:` in a job, with the checkout step's `uses:` entries dropped. */
const runStepsOf = (jobId: string): string[] =>
  (workflow.jobs[jobId]?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === 'string');

describe.each(STATIC_GUARDS)('$jobId', ({ jobId, command }) => {
  it('is a single `run:` in CI that invokes the script and nothing else', () => {
    expect(runStepsOf(jobId)).toEqual([command]);
  });

  it('is declared as a verify gate running that exact command', () => {
    const gate = verifyConfig.gates.find((g) => g.id === jobId);
    expect(gate, `${jobId} is missing from ${VERIFY_CONFIG}`).toBeDefined();
    expect(gate?.command).toBe(command);
  });
});

describe('neither declaration site carries a second copy of the logic', () => {
  /**
   * Shell constructs that mean the check was re-implemented rather than called.
   * `wc -c` / `git grep` / a bare limit are the three things that were inline
   * before #1882, so those are the three that must not come back.
   */
  const REIMPLEMENTATION_MARKERS: readonly [RegExp, string][] = [
    [/\bgit\s+grep\b/, 'git grep — the token-discipline pattern belongs in the script'],
    [/\bwc\s+-c\b/, 'wc -c — the CLAUDE.md size measurement belongs in the script'],
    [/\b35000\b/, '35000 — the CLAUDE.md byte cap belongs in the script'],
    [/:\(exclude\)/, 'a git pathspec exclusion — the guarded list belongs in the script'],
    [/Terminal\[\^:\]/, 'the *Terminal* exemption regex — it belongs in the script'],
    [
      /\bgenerateStaticParams\b|\bpreferredRegion\b|\bfetchCache\b/,
      'a Next route field name — the route-exports allow-list belongs in the script',
    ],
  ];

  it.each(STATIC_GUARDS)('$jobId: the CI job body is free of them', ({ jobId }) => {
    const body = runStepsOf(jobId).join('\n');
    for (const [marker, why] of REIMPLEMENTATION_MARKERS) {
      expect(marker.test(body), `${jobId} re-implements the check: ${why}`).toBe(false);
    }
  });

  it('verify.yaml gate commands only ever invoke a script', () => {
    for (const { jobId } of STATIC_GUARDS) {
      const gate = verifyConfig.gates.find((g) => g.id === jobId);
      for (const [marker, why] of REIMPLEMENTATION_MARKERS) {
        expect(marker.test(gate?.command ?? ''), `gate ${jobId}: ${why}`).toBe(false);
      }
    }
  });
});

describe('the gates that were deliberately NOT added stay out', () => {
  /**
   * Adding these would be a change of policy, not a fix, so it should be a
   * conscious edit to this list rather than a quiet append to verify.yaml.
   * Declared gates run on EVERY `wait --verify`, and `/orchestrate` waits on
   * that number for every worker.
   *
   *   test-integration — 2.1m measured, on top of unit's 12.3m
   *   legacy-tmux-readmode — needs Docker; the runner here may have none
   *   security-audit — reaches the npm registry; a network blip is not a verdict
   *   build — replaces the chunks the running server is serving mid-flight
   *   test-e2e — 5m+ per worker (already argued in verify.yaml's own comment)
   *
   * [Issue #1946] `build` stays out even though #1943's defect was a BUILD
   * failure, and so does `integration`. Measured once each in this linked
   * worktree, cold (no `.next`): `npm run build` = 219s, `npm run
   * test:integration` = 32s then 51s — and integration is RED on develop as it
   * stands (4 tests, all `Test timed out in 5000ms`, reproduced on both runs),
   * so declaring it today would make every worker's verdict exit 20 regardless
   * of its diff. The `route-exports` guard added here re-states, statically and
   * in 0.3s, the one property of a route module that only `next build` could
   * see. It is a narrower thing than a build gate, not a substitute for one;
   * see dev-reports/issue-1946-gate-coverage.md.
   */
  const NOT_DECLARED = ['integration', 'legacy-tmux', 'security-audit', 'build', 'e2e'];

  it.each(NOT_DECLARED)('%s is not a declared gate', (id) => {
    expect(verifyConfig.gates.map((g) => g.id)).not.toContain(id);
  });
});

describe('the existing gates and options are untouched', () => {
  it('still declares lint / typecheck / unit with their original commands', () => {
    const byId = new Map(verifyConfig.gates.map((g) => [g.id, g.command]));
    expect(byId.get('lint')).toBe('npm run lint');
    expect(byId.get('typecheck')).toBe('npx tsc --noEmit');
    expect(byId.get('unit')).toBe('npm run test:unit');
  });

  it('keeps baseRef and skipInPrimaryCheckout as they were', () => {
    const options = (parse(readFileSync(VERIFY_CONFIG, 'utf-8')) as {
      options: { baseRef: string; skipInPrimaryCheckout: boolean };
    }).options;
    expect(options.baseRef).toBe('origin/develop');
    expect(options.skipInPrimaryCheckout).toBe(true);
  });
});
