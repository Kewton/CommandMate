/**
 * `/orchestrate` 6-2 and 6-3 give the same answer about `pending` (Issue #2330).
 *
 * ## What happened
 *
 * 6-2 says the orchestrator may merge **without waiting for the PR's own CI** —
 * the local gate (refresh -> conflict-marker sweep -> `tsc` -> affected tests)
 * plus the develop push run are what actually guard the merge. 6-3, twelve lines
 * later, said `pending` は待ち. Both are instructions to the same LLM in the same
 * run, and it has to pick one; whichever it picks, half the runbook says it was
 * wrong. In practice it waited, which is the 12-25 minutes per issue 6-2 exists
 * to reclaim.
 *
 * #2330 also gave the pair a mechanical consequence: merging now cancels the
 * PR's own run (`.github/workflows/cancel-pr-runs-on-close.yml`), so a merged
 * PR routinely shows `cancelled` checks. An orchestrator that still reads
 * "`cancel` は拒否" as covering that will refuse to merge the next PR in the
 * batch, or will go looking for a failure that never happened.
 *
 * ## Why a test rather than trusting the edit
 *
 * Prose contradictions do not fail anything. This file is executed by an LLM,
 * so a stale clause is a live defect with no other detector — the same reason
 * tests/unit/tasks/orchestrate-changelog-fragment-example.test.ts pins 2-4-1's
 * worked example against the real CHANGELOG rather than against a copy.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const CANCEL_WORKFLOW = 'cancel-pr-runs-on-close.yml';

const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  expect(start, `${ORCHESTRATE_PATH} has no \`### ${id}.\` heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  // Anti-vacuity: a heading rename that left an empty body would satisfy every
  // `not.toMatch` below.
  expect(body.trim().length, `section ${id} is empty`).toBeGreaterThan(200);
  return body;
}

describe('/orchestrate: the merge gate says one thing (Issue #2330)', () => {
  it('6-2 tells the orchestrator the PR run is cancelled for it', () => {
    const body = section('6-2');
    expect(body).toContain(CANCEL_WORKFLOW);
    // The instruction that actually changes behaviour: do not hand-cancel, and
    // do not read the resulting `cancelled` as a failure.
    expect(body).toMatch(/手でキャンセル/);
    expect(body).toMatch(/`cancelled`/);
  });

  it('6-2 says the develop / main push runs are not touched', () => {
    // If the runbook does not say this, the next reader has no way to know the
    // safety net survives, and the honest response to that doubt is to wait —
    // which is the cost 6-2 exists to remove.
    const body = section('6-2');
    expect(body).toMatch(/--event pull_request/);
    expect(body).toMatch(/push run/);
  });

  it('6-3 no longer says `pending` is something to wait for', () => {
    const body = section('6-3');
    expect(
      body,
      '6-3 must not reinstate the wait that 6-2 removes; see the header of this file.'
    ).not.toMatch(/`pending`\s*は待ち/);
    // …and must not restate it in the stricter form it used to carry, which
    // rejects `pending` by implication.
    expect(body).not.toMatch(/1 つでも\s*`pass`\s*以外/);
  });

  it('6-3 restates 6-2’s exception explicitly, including the last PR', () => {
    const body = section('6-3');
    expect(body).toMatch(/`pending`/);
    expect(body).toMatch(/6-2/);
    expect(body).toMatch(/待たなくてよい/);
    // The one case that still waits, in both sections, worded the same way.
    expect(body).toMatch(/最後の 1 本だけ/);
    expect(section('6-2')).toMatch(/最後の 1 本だけ/);
  });

  it('6-3 still rejects `fail` and `cancel` as merge blockers', () => {
    const body = section('6-3');
    expect(body).toMatch(/`fail`/);
    expect(body).toMatch(/`cancel`/);
    expect(body).toMatch(/マージしない/);
  });
});
