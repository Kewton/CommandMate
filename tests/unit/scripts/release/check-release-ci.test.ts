/**
 * `scripts/check-release-ci.mjs` (Issue #3111): the publish workflow's gate in
 * place of re-running `npm run test:unit`. It may only let `npm publish` run
 * when CI's required checks passed on the tag commit.
 *
 * `gh` is injected, so every branch runs without the network. The four outcomes
 * that must NOT publish are asserted on the verdict AND on how many times `gh`
 * was asked, so a version that gives up early (or never gives up) is caught.
 * The CLI is also spawned once to pin the exit code the runner reads.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

// tsc reads the JSDoc types off the .mjs directly (allowJs).
import {
  checkReleaseCi,
  classifyCheckRuns,
  DEFAULT_REQUIRED_CHECKS,
  GITHUB_ACTIONS_APP_ID,
} from '../../../../scripts/check-release-ci.mjs';

const SCRIPT = resolve(__dirname, '../../../../scripts/check-release-ci.mjs');
const REPO = 'Kewton/CommandMate';
const SHA = '496c67cc9f6404b9dda97322ad171d52ddcc7bae';

type Run = { id: number; name: string; status: string; conclusion: string | null };

/** Build a fake `gh` that answers per check name; `answer` may change per call. */
function fakeGh(answer: (name: string, call: number) => Run[] | Error) {
  const calls: string[][] = [];
  const runGh = (args: string[]): string => {
    calls.push(args);
    const url = new URL(`https://x/${args[1]}`);
    const name = url.searchParams.get('check_name') ?? '';
    const result = answer(name, calls.length);
    if (result instanceof Error) throw result;
    return JSON.stringify({ total_count: result.length, check_runs: result });
  };
  return { runGh, calls };
}

/** A clock that advances by the slept amount, so deadlines are deterministic. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const ok = (name: string, id = 1): Run => ({ id, name, status: 'completed', conclusion: 'success' });

describe('check-release-ci (Issue #3111)', () => {
  it('requires the checks main\'s branch protection requires, from github-actions', () => {
    expect(DEFAULT_REQUIRED_CHECKS).toEqual(['Unit Tests', 'Build']);
    expect(GITHUB_ACTIONS_APP_ID).toBe(15368);
  });

  it('publishes when every required check completed with success', async () => {
    const { runGh, calls } = fakeGh((name) => [ok(name)]);
    const verdict = await checkReleaseCi({ repo: REPO, sha: SHA, runGh, ...fakeClock() });
    expect(verdict.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toContain(`repos/${REPO}/commits/${SHA}/check-runs?`);
    expect(calls[0][1]).toContain('check_name=Unit+Tests');
    expect(calls[0][1]).toContain(`app_id=${GITHUB_ACTIONS_APP_ID}`);
  });

  it('waits while a check is still running, then publishes once it passes', async () => {
    const { runGh, calls } = fakeGh((name, call) =>
      name === 'Unit Tests' && call < 5
        ? [{ id: 1, name, status: 'in_progress', conclusion: null }]
        : [ok(name)]
    );
    const verdict = await checkReleaseCi({ repo: REPO, sha: SHA, runGh, intervalMs: 1000, ...fakeClock() });
    expect(verdict.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(2);
  });

  it('does not publish when a required check failed, and stops at once', async () => {
    const { runGh, calls } = fakeGh((name) =>
      name === 'Unit Tests' ? [{ id: 1, name, status: 'completed', conclusion: 'failure' }] : [ok(name)]
    );
    const verdict = await checkReleaseCi({ repo: REPO, sha: SHA, runGh, ...fakeClock() });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Unit Tests conclusion=failure');
    expect(calls).toHaveLength(2);
  });

  it('does not publish when a required check run never appears before the deadline', async () => {
    const { runGh, calls } = fakeGh((name) => (name === 'Build' ? [] : [ok(name)]));
    const verdict = await checkReleaseCi({
      repo: REPO, sha: SHA, runGh, timeoutMs: 60_000, intervalMs: 30_000, ...fakeClock(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Build no check run found');
    // t=0, 30s, 60s → three polls, then gives up instead of looping forever.
    expect(calls).toHaveLength(6);
  });

  it('does not publish when gh itself fails', async () => {
    const { runGh, calls } = fakeGh(() => new Error('HTTP 502'));
    const verdict = await checkReleaseCi({ repo: REPO, sha: SHA, runGh, ...fakeClock() });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('HTTP 502');
    expect(calls).toHaveLength(1);
  });

  it('does not publish when gh answers something that is not a check-runs payload', async () => {
    const verdict = await checkReleaseCi({
      repo: REPO, sha: SHA, runGh: () => '{"message":"Not Found"}', ...fakeClock(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no check_runs array');
  });

  it('judges a re-run by its latest run, not the first one', () => {
    expect(
      classifyCheckRuns([
        { id: 1, name: 'Unit Tests', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'Unit Tests', status: 'completed', conclusion: 'success' },
      ]).state
    ).toBe('success');
    expect(classifyCheckRuns([{ id: 3, name: 'Build', status: 'completed', conclusion: 'cancelled' }]).state).toBe(
      'failure'
    );
  });

  it('exits non-zero from the CLI when arguments are missing', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', REPO], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('::error::');
  });
});
