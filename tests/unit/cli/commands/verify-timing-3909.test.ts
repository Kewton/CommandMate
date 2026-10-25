/**
 * Human output of `verify` and `verify history` shows a gate's waits and its
 * execution apart (Issue #3909), and leaves a gate without them as it was.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import type {
  VerificationGateResultView,
  VerificationRunSummaryView,
  VerificationRunView,
} from '../../../../src/cli/types/api-responses';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

function mockFetch(responses: { data: unknown; status?: number }[]) {
  const fn = vi.fn();
  for (const resp of responses) {
    const status = resp.status ?? 200;
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(resp.data),
      text: () => Promise.resolve(JSON.stringify(resp.data)),
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function gate(over: Partial<VerificationGateResultView> = {}): VerificationGateResultView {
  return {
    id: 1,
    runId: 7,
    gateId: 'lint',
    command: 'npm run lint',
    status: 'passed',
    exitCode: 0,
    durationMs: 12300,
    logTail: null,
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:00:12.300Z',
    ...over,
  };
}

function run(gates: VerificationGateResultView[]): VerificationRunView {
  return {
    id: 7,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'manual',
    status: 'passed',
    baseRef: 'origin/develop',
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:20:00.000Z',
    gates,
  };
}

function summary(gates: VerificationRunSummaryView['gates']): VerificationRunSummaryView {
  return {
    id: 7,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'wait',
    status: 'passed',
    baseRef: 'origin/develop',
    startedAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:20:00.000Z',
    gates,
  };
}

async function loadCommand() {
  const { createVerifyCommand } = await import('../../../../src/cli/commands/verify');
  return createVerifyCommand();
}

const stderrLines = () => mockConsoleError.mock.calls.map((call) => String(call[0]));
const stdout = () => mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');

describe('the GATE line (Issue #3909)', () => {
  it('shows queue, mutex and run for a gate with the [timing] marker', async () => {
    mockFetch([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run([
            gate({
              id: 11,
              gateId: 'unit',
              durationMs: 600000,
              logTail:
                '[mutex] name=cpu.heavy waited=120.0s lock=/home/dev/.commandmate/locks/cpu.heavy.lock\n' +
                'Tests 100 passed\n[timing] queue=30.0s mutex=120.0s run=600.0s',
            }),
            // Waited for a slot only: no [mutex] line, still a [timing] line.
            gate({ id: 12, gateId: 'lint', logTail: '[timing] queue=4.2s mutex=0.0s run=12.3s' }),
          ]),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(stderrLines()).toContain('GATE unit PASS (exit=0, 600.0s, queue=30.0s, mutex=120.0s, run=600.0s)');
    expect(stderrLines()).toContain('GATE lint PASS (exit=0, 12.3s, queue=4.2s, mutex=0.0s, run=12.3s)');
    // The lock wait is said once, as mutex=, not again as waited=.
    expect(stderrLines().join('\n')).not.toContain('waited=');
  });

  it('keeps the line of a gate without the marker (negative control)', async () => {
    mockFetch([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run([
            gate({ id: 11, gateId: 'lint' }),
            // A server older than #3884: the [mutex] line alone.
            gate({
              id: 12,
              gateId: 'e2e',
              durationMs: 190000,
              logTail: '[mutex] name=e2e-port waited=42.3s lock=/l\nall specs passed',
            }),
            // A gate's own output printing the marker mid-log is not the runner's line.
            gate({ id: 13, gateId: 'typecheck', logTail: '[timing] queue=9.0s mutex=9.0s run=9.0s\ndone' }),
          ]),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(stderrLines()).toContain('GATE lint PASS (exit=0, 12.3s)');
    expect(stderrLines()).toContain('GATE e2e PASS (exit=0, 190.0s, waited=42.3s)');
    expect(stderrLines()).toContain('GATE typecheck PASS (exit=0, 12.3s)');
  });
});

describe('verify history (Issue #3909)', () => {
  it('names the gates that carry timing, with their waits and execution apart', async () => {
    mockFetch([
      {
        data: {
          runs: [
            summary([
              { gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 12_300 },
              {
                gateId: 'unit',
                status: 'passed',
                exitCode: 0,
                durationMs: 600_000,
                timing: { queueSec: 30, mutexSec: 120, runSec: 600 },
              },
              {
                gateId: 'build',
                status: 'failed',
                exitCode: 1,
                durationMs: 90_000,
                timing: { queueSec: 0, mutexSec: 2.5, runSec: 90 },
              },
            ]),
          ],
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stdout()).toBe(
      '#7  2026-10-25T00:00:00.000Z  wt1  wait  passed  failed: build' +
        '  timing: unit(queue=30.0s mutex=120.0s run=600.0s) build(queue=0.0s mutex=2.5s run=90.0s)'
    );
  });

  it('prints the line it always did when no gate carries timing (negative control)', async () => {
    mockFetch([
      {
        data: {
          runs: [summary([{ gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 12_300 }])],
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stdout()).toBe('#7  2026-10-25T00:00:00.000Z  wt1  wait  passed');
  });
});
