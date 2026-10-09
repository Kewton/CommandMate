/**
 * Gate notices on the CLI's verdict lines (Issue #3478).
 *
 * The end-to-end path (script → gate runner → CLI) is in
 * tests/unit/verification/lint-sh-notice-3478.test.ts; this pins the CLI's own
 * rules on synthetic rows.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseGateNotices, runVerification } from '../../../../src/cli/utils/verify-runner';
import type { ApiClient } from '../../../../src/cli/utils/api-client';
import type {
  VerificationGateResultView,
  VerificationRunView,
} from '../../../../src/cli/types/api-responses';

afterEach(() => {
  vi.restoreAllMocks();
});

function gate(over: Partial<VerificationGateResultView>): VerificationGateResultView {
  return {
    id: 1,
    runId: 7,
    gateId: 'lint-sh',
    command: 'node scripts/run-lint-sh-if-changed.mjs --base origin/develop',
    status: 'passed',
    exitCode: 0,
    durationMs: 100,
    logTail: null,
    startedAt: '2026-10-09T00:00:00.000Z',
    finishedAt: '2026-10-09T00:00:00.100Z',
    ...over,
  };
}

async function printed(gates: VerificationGateResultView[], status: VerificationRunView['status']) {
  const run = { id: 7, status, gates } as unknown as VerificationRunView;
  const client = {
    post: vi.fn().mockResolvedValue({ runId: 7 }),
    get: vi.fn().mockResolvedValue({ run }),
  } as unknown as ApiClient;
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runVerification(client, { worktreeId: 'wt', trigger: 'manual' });
  return stderr.mock.calls.map((call) => String(call[0]));
}

describe('parseGateNotices', () => {
  it('reads only line-anchored markers, in order', () => {
    expect(
      parseGateNotices('a\n[cmate-notice] first\nsays [cmate-notice] not this\n[cmate-notice] second\n')
    ).toEqual(['first', 'second']);
  });

  it('returns nothing for an empty or marker-free log', () => {
    expect(parseGateNotices(null)).toEqual([]);
    expect(parseGateNotices('plain output\n')).toEqual([]);
  });

  it('caps a notice so a gate cannot flood the verdict lines', () => {
    expect(parseGateNotices(`[cmate-notice] ${'x'.repeat(500)}`)[0]).toHaveLength(200);
  });
});

describe('runVerification prints notices beside a PASS', () => {
  it('prints the notice right after the GATE line', async () => {
    const lines = await printed(
      [gate({ logTail: 'checking\n[cmate-notice] shellcheck is not installed: 1 changed .sh NOT linted' })],
      'passed'
    );
    const at = lines.findIndex((line) => line.startsWith('GATE lint-sh PASS'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('NOTICE lint-sh: shellcheck is not installed: 1 changed .sh NOT linted');
  });

  it('prints nothing extra for a PASS without notices (negative control)', async () => {
    const lines = await printed([gate({ logTail: 'no .sh changed\n' })], 'passed');
    expect(lines.filter((line) => line.startsWith('NOTICE'))).toEqual([]);
  });

  it('does not repeat a failing gate\'s notice; its log is already echoed', async () => {
    const lines = await printed(
      [gate({ status: 'failed', exitCode: 1, logTail: 'SC2034\n[cmate-notice] linted with shellcheck 0.9.0; CI pins 0.11.0' })],
      'failed'
    );
    expect(lines.filter((line) => line.startsWith('NOTICE'))).toEqual([]);
    expect(lines.join('\n')).toContain('[cmate-notice] linted with shellcheck 0.9.0');
  });
});
