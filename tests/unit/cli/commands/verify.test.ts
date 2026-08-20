/**
 * verify Command Tests
 * Issue #1544
 *
 * Every polling test drives fake timers and asserts the exact number of HTTP
 * calls, so a verdict can never be produced by wall-clock luck.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, VerifyExitCode } from '../../../../src/cli/types';
import {
  exitCodeForRunStatus,
  MAX_PRINTED_LOG_TAIL_LINES,
  parseGateIds,
} from '../../../../src/cli/utils/verify-runner';
import type {
  VerificationGateResultView,
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
  vi.useRealTimers();
});

interface MockResponse {
  data: unknown;
  status?: number;
}

function toResponse(resp: MockResponse) {
  const status = resp.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(resp.data),
    text: () => Promise.resolve(JSON.stringify(resp.data)),
  };
}

/**
 * Mock fetch with a finite sequence, then repeat `tail` forever.
 * Without a repeating tail an exhausted sequence resolves `undefined`, which
 * surfaces as a network error and would let a poll test pass for the wrong
 * reason.
 */
function mockFetchWithTail(responses: MockResponse[], tail?: MockResponse) {
  const fn = vi.fn();
  responses.forEach((resp) => fn.mockResolvedValueOnce(toResponse(resp)));
  if (tail) fn.mockResolvedValue(toResponse(tail));
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
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:00:12.300Z',
    ...over,
  };
}

function run(over: Partial<VerificationRunView> = {}): VerificationRunView {
  return {
    id: 7,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'manual',
    status: 'passed',
    baseRef: 'origin/develop',
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:01:00.000Z',
    gates: [],
    ...over,
  };
}

const workEvidencePassed = gate({
  id: 10,
  gateId: 'work-evidence',
  command: 'git merge-base / rev-list / status --porcelain',
  logTail: 'work-evidence: baseRef=origin/develop commits=3 uncommitted=2',
});

async function loadCommand() {
  const { createVerifyCommand } = await import('../../../../src/cli/commands/verify');
  return createVerifyCommand();
}

describe('createVerifyCommand', () => {
  it('creates a Command named "verify"', async () => {
    const cmd = await loadCommand();
    expect(cmd.name()).toBe('verify');
  });

  it('declares the documented options', async () => {
    const cmd = await loadCommand();
    const flags = cmd.options.map((opt) => opt.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--instance', '--gates', '--json', '--timeout', '--token'])
    );
  });
});

describe('VerifyExitCode values', () => {
  it('pins the documented codes', () => {
    expect(VerifyExitCode.SUCCESS).toBe(0);
    expect(VerifyExitCode.VERIFY_FAILED).toBe(20);
    expect(VerifyExitCode.NOT_STARTED).toBe(21);
    expect(VerifyExitCode.TIMEOUT).toBe(124);
  });
});

describe('exitCodeForRunStatus', () => {
  it('maps passed to 0', () => {
    expect(exitCodeForRunStatus('passed')).toBe(VerifyExitCode.SUCCESS);
  });

  it('maps failed to 20', () => {
    expect(exitCodeForRunStatus('failed')).toBe(VerifyExitCode.VERIFY_FAILED);
  });

  it('maps not_started to 21', () => {
    expect(exitCodeForRunStatus('not_started')).toBe(VerifyExitCode.NOT_STARTED);
  });

  it('maps verdict-less runs (error/cancelled) to 99, never to 0 or 20', () => {
    for (const status of ['error', 'cancelled'] as const) {
      expect(exitCodeForRunStatus(status)).toBe(ExitCode.UNEXPECTED_ERROR);
      expect(exitCodeForRunStatus(status)).not.toBe(VerifyExitCode.SUCCESS);
      expect(exitCodeForRunStatus(status)).not.toBe(VerifyExitCode.VERIFY_FAILED);
    }
  });
});

describe('parseGateIds', () => {
  it('returns undefined when --gates is absent', () => {
    expect(parseGateIds(undefined)).toBeUndefined();
  });

  it('splits and trims ids', () => {
    expect(parseGateIds('lint, unit ')).toEqual(['lint', 'unit']);
  });

  it('returns null when the value names no gate', () => {
    expect(parseGateIds(' , ')).toBeNull();
  });
});

describe('verify command action', () => {
  it('exits 0 when the run passes', async () => {
    const fetchMock = mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'passed', gates: [workEvidencePassed, gate()] }) } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockConsoleLog).toHaveBeenCalledWith('RESULT passed');
  });

  it('exits 20 and never 0 when a gate fails', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({ id: 11, gateId: 'unit', command: 'npm run test:unit', status: 'failed', exitCode: 1, durationMs: 45000, logTail: '2 tests failed' }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
    expect(mockConsoleLog).toHaveBeenCalledWith('RESULT failed');
    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit FAIL (exit=1, 45.0s)');
    // The log tail is what makes a CLI failure actionable.
    expect(mockConsoleError).toHaveBeenCalledWith('2 tests failed');
  });

  it('marks a contract-defined gate so the report says which verdict was Issue-specific', async () => {
    // Issue #1791. verify.yaml can be read off disk; the contract's copy lives
    // in tasks.contract_json, so an unmarked GATE line has to mean "the
    // repository's own criterion" for the separation to be legible at all.
    // The marker is appended, leaving the `GATE <id> <LABEL>` prefix that
    // existing log readers match on untouched.
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({ id: 11, gateId: 'lint', source: 'verify.yaml' }),
              gate({
                id: 12, gateId: 'issue-1791-repro', command: 'node repro.mjs',
                status: 'failed', exitCode: 3, durationMs: 2000, logTail: 'repro failed',
                source: 'contract',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      'GATE issue-1791-repro FAIL (exit=3, 2.0s) [contract]'
    );
    // Repository and built-in gates are unmarked, so output in a repository
    // that never uses the feature is byte-identical to before #1791.
    expect(mockConsoleError).toHaveBeenCalledWith('GATE lint PASS (exit=0, 12.3s)');
    expect(mockConsoleError).toHaveBeenCalledWith('GATE work-evidence PASS (commits=3, uncommitted=2)');
  });

  it('prints the mutex wait beside the duration, never folded into it', async () => {
    // Issue #1771. `duration` is what the gate's command took; `waited` is what
    // the machine made it queue for. A reader tuning timeoutSec, and the advisor
    // reading these numbers back, both need them apart.
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'passed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11,
                gateId: 'e2e',
                command: 'npm run test:e2e',
                durationMs: 190000,
                logTail:
                  '[mutex] name=e2e-port waited=42.3s lock=/home/dev/.commandmate/locks/e2e-port.lock\nall specs passed',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('GATE e2e PASS (exit=0, 190.0s, waited=42.3s)');
    // 190.0s is the command's own time. A runner that added the wait would print
    // 232.3s here and nothing downstream could tell.
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('GATE e2e PASS (exit=0, 232.3s')
    );
  });

  it('does not read waited= out of a gate\'s own output', async () => {
    // The marker is anchored to the start of a line, so a suite that happens to
    // print `waited=` cannot put a number the runner never measured on the
    // GATE line.
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'passed',
            gates: [
              workEvidencePassed,
              gate({ id: 11, gateId: 'unit', logTail: 'server waited=99.9s for the port' }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit PASS (exit=0, 12.3s)');
  });

  it('prints reason=mutex-wait for a gate whose lock never came free', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'error',
            gates: [
              workEvidencePassed,
              gate({
                id: 11,
                gateId: 'e2e',
                status: 'skipped',
                exitCode: null,
                durationMs: 0,
                logTail:
                  'reason=mutex-wait waited=600.0s\n[mutex] name=e2e-port lock=/home/dev/.commandmate/locks/e2e-port.lock',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('GATE e2e SKIP (reason=mutex-wait waited=600.0s)');
    // 99, not 20: no verdict was reached, and a caller branching on 20 must be
    // able to trust that the gate actually judged the work.
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });

  // Issue #1772: a gate that fails on the machine's luck and passes on a
  // re-run has no word in PASS/FAIL that is true of it. FLAKY is that word, and
  // it has to carry both runs' numbers or it says nothing a reader can act on.
  const FLAKY_TAIL = [
    '[flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=fail',
    '--- [flaky] run 1/2: failed exit=1 duration=45.0s ---',
    'AssertionError: expected not to contain "fac-"',
    '--- [flaky] run 2/2: passed exit=0 duration=44.0s ---',
    '53 passed',
  ].join('\n');

  it('prints FLAKY with both runs\' exit codes and durations', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'unit', command: 'npm run test:unit',
                status: 'failed', exitCode: 1, durationMs: 89000, logTail: FLAKY_TAIL,
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // The exact spelling docs/design/verification-config.md §9.3 fixes for this
    // runner. The stored columns hold one run; printing them would drop half
    // the evidence the retry exists to produce.
    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit FLAKY (exit=1,0, 45.0s,44.0s)');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('GATE unit FAIL')
    );
    // Default flakyIsPass: the gate did not get weaker by opting into a retry.
    expect(mockConsoleLog).toHaveBeenCalledWith('RESULT failed');
    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
  });

  it('still prints FLAKY, and exits 0, when the gate declared flakyIsPass', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'passed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'unit', command: 'npm run test:unit',
                status: 'passed', exitCode: 0, durationMs: 89000,
                logTail: FLAKY_TAIL.replace('verdict=fail', 'verdict=pass'),
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // Counting a flake as a pass must not erase the flake: PASS here would hide
    // the one fact the whole feature exists to surface.
    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit FLAKY (exit=1,0, 45.0s,44.0s)');
    expect(mockConsoleLog).toHaveBeenCalledWith('RESULT passed');
    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
  });

  it('keeps FAIL for a gate that failed both runs, and shows both', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'unit', status: 'failed', exitCode: 1, durationMs: 89000,
                logTail: '[flaky] runs=2 outcome=fail exit=1,1 duration=45.0s,44.0s verdict=fail',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // The retry agreed; nothing about this gate was flaky.
    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit FAIL (exit=1,1, 45.0s,44.0s)');
    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
  });

  it('keeps the mutex wait beside a FLAKY gate\'s two durations', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'e2e', status: 'failed', exitCode: 1, durationMs: 89000,
                logTail:
                  '[flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=fail\n' +
                  '[mutex] name=e2e-port waited=42.3s lock=/home/dev/.commandmate/locks/e2e-port.lock',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // The two features compose: `waited` still trails, still separate from
    // both durations rather than folded into either.
    expect(mockConsoleError).toHaveBeenCalledWith(
      'GATE e2e FLAKY (exit=1,0, 45.0s,44.0s, waited=42.3s)'
    );
  });

  it('does not read a flaky marker out of a gate\'s own output', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'unit',
                logTail: 'suite printed  [flaky] runs=2 outcome=flaky exit=9,9 duration=1.0s,1.0s verdict=pass',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // Anchored to the start of a line, so a suite that echoes the marker cannot
    // claim a retry that never happened.
    expect(mockConsoleError).toHaveBeenCalledWith('GATE unit PASS (exit=0, 12.3s)');
  });

  it('prints a scope failure with its out-of-scope paths and the scope.allow guidance', async () => {
    // Mirrors the report evaluateScope() builds (scope-gate.ts); below the
    // display cap it must reach stderr verbatim — the paths are what let a
    // worker see that a lockfile is missing from the issue's target files
    // (#1683, from #1678 B-2).
    const scopeTail = [
      'scope: baseRef=origin/develop changed=3 violations=2',
      'allow: src/cli/**, tests/**',
      'deny: (none)',
      'out of scope:',
      '  - package-lock.json',
      '  - web/src/map.ts',
      "To allow this diff, add the paths above to the contract's scope.allow.",
    ].join('\n');
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({ id: 12, gateId: 'scope', command: 'git diff --name-only / status --porcelain × contract scope', status: 'failed', exitCode: 1, durationMs: 200, logTail: scopeTail }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockConsoleError).toHaveBeenCalledWith('GATE scope FAIL (exit=1, 0.2s)');
    expect(mockConsoleError).toHaveBeenCalledWith(scopeTail);
  });

  it('caps a long log tail to its last lines and counts the omitted rest', async () => {
    const total = MAX_PRINTED_LOG_TAIL_LINES + 10;
    const longTail = Array.from(
      { length: total },
      (_, i) => `line-${String(i).padStart(3, '0')}`
    ).join('\n');
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              gate({ id: 11, gateId: 'unit', command: 'npm run test:unit', status: 'failed', exitCode: 1, logTail: longTail }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    const printed = mockConsoleError.mock.calls
      .map((call) => call[0])
      .find((arg): arg is string => typeof arg === 'string' && arg.includes('line-'));
    expect(printed).toBeDefined();
    expect(
      printed!.startsWith(
        '... (+10 more lines; run `commandmate verify show 7` for the full log)'
      )
    ).toBe(true);
    // The tail survives: that is where a suite's summary and scope's guidance sit.
    expect(printed).toContain(`line-${String(total - 1).padStart(3, '0')}`);
    expect(printed).not.toContain('line-000');
    expect(printed!.split('\n')).toHaveLength(MAX_PRINTED_LOG_TAIL_LINES + 1);
  });

  it('exits 21 when work-evidence finds nothing to verify', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'not_started',
            gates: [
              gate({
                id: 10,
                gateId: 'work-evidence',
                command: 'git merge-base / rev-list / status --porcelain',
                status: 'failed',
                exitCode: 1,
                logTail:
                  'work-evidence: baseRef=origin/develop commits=0 uncommitted=0\nNo commits and no uncommitted changes: nothing to verify.',
              }),
              gate({ id: 11, status: 'skipped', exitCode: null, durationMs: 0, logTail: 'skipped: the work-evidence gate did not pass.' }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
    expect(mockConsoleError).toHaveBeenCalledWith('GATE work-evidence FAIL (commits=0, uncommitted=0)');
  });

  it('renders work-evidence counts rather than an exit status', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'passed', gates: [workEvidencePassed] }) } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockConsoleError).toHaveBeenCalledWith('GATE work-evidence PASS (commits=3, uncommitted=2)');
  });

  it('exits 99 when the run ends without a verdict (all gates skipped)', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'error',
            gates: [
              workEvidencePassed,
              gate({ id: 11, status: 'skipped', exitCode: null, durationMs: 0, logTail: 'skipped: worktreePath is the server process working directory and options.skipInPrimaryCheckout is true.' }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('GATE lint SKIP (skipped: worktreePath is the server process working directory')
    );
  });

  it('keeps polling while the run is running and reports each gate exactly once', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'running', finishedAt: null, gates: [workEvidencePassed, gate({ status: 'running', exitCode: null, durationMs: null, finishedAt: null })] }) } },
      { data: { run: run({ status: 'passed', gates: [workEvidencePassed, gate()] }) } },
    ]);

    const cmd = await loadCommand();
    const promise = cmd.parseAsync(['node', 'verify', 'wt1']);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const workEvidenceLines = mockConsoleError.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('GATE work-evidence')
    );
    expect(workEvidenceLines).toHaveLength(1);
  });

  it('exits 124 after --timeout elapses, with the poll count pinned', async () => {
    vi.useFakeTimers();
    const runningRun = { data: { run: run({ status: 'running', finishedAt: null, gates: [] }) } };
    const fetchMock = mockFetchWithTail(
      [{ data: { runId: 7 }, status: 202 }],
      runningRun
    );

    const cmd = await loadCommand();
    const promise = cmd.parseAsync(['node', 'verify', 'wt1', '--timeout', '10']);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.TIMEOUT);
    // 1 POST + polls at t=0, t=5s, t=10s. Pinning the count proves the exit came
    // from the deadline check, not from the sequence running dry.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('exceeded 10s'));
  });

  it('does not time out when the verdict lands exactly on the deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'running', finishedAt: null, gates: [] }) } },
      { data: { run: run({ status: 'running', finishedAt: null, gates: [] }) } },
      { data: { run: run({ status: 'passed', gates: [gate()] }) } },
    ]);

    const cmd = await loadCommand();
    const promise = cmd.parseAsync(['node', 'verify', 'wt1', '--timeout', '10']);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.TIMEOUT);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('sends trigger=manual and the parsed --gates in the POST body', async () => {
    const fetchMock = mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'passed', gates: [gate()] }) } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--gates', 'lint,unit', '--instance', 'codex-2']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/worktrees/wt1/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      trigger: 'manual',
      instanceId: 'codex-2',
      gateIds: ['lint', 'unit'],
    });
  });

  it('prints the run as JSON on stdout with --json and omits the RESULT line', async () => {
    const runView = run({ status: 'failed', gates: [gate({ status: 'failed', exitCode: 1 })] });
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: runView } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--json']);

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const printed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(printed.status).toBe('failed');
    expect(printed.gates).toHaveLength(1);
  });

  it('adds machine-readable scope evidence to the JSON, leaving every other field alone', async () => {
    // Issue #1841. `scope.allow: ["src/**"]` is a claim; which files it actually
    // covered on the day it ran is only in the gate's report, and a consumer
    // should not have to re-parse prose to read it.
    const scopeTail = [
      'scope: baseRef=origin/develop changed=3 violations=1',
      'allow: src/**, docs/*.md',
      'deny: src/secret/**',
      'admitted:',
      '  + docs/x.md  \u2190 docs/*.md',
      '  + src/a/b.ts  \u2190 src/**',
      'out of scope:',
      '  - src/secret/key.ts  \u2190 src/secret/**',
      'To allow this diff, add the paths above to the contract\'s scope.allow.',
    ].join('\n');
    const scopeGate = gate({
      id: 12, gateId: 'scope', status: 'failed', exitCode: 1, durationMs: 200,
      logTail: scopeTail,
    });
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      { data: { run: run({ status: 'failed', gates: [workEvidencePassed, scopeGate] }) } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--json']);

    const printed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    const printedScope = printed.gates.find(
      (g: VerificationGateResultView) => g.gateId === 'scope'
    );
    expect(printedScope.scope).toEqual({
      admitted: [
        { path: 'docs/x.md', pattern: 'docs/*.md' },
        { path: 'src/a/b.ts', pattern: 'src/**' },
      ],
      violations: ['src/secret/key.ts'],
      totals: { changed: 3, admitted: 2, violations: 1 },
    });
    // The evidence is added, not substituted: the report a human reads is
    // still there verbatim, and the verdict fields are untouched.
    expect(printedScope.logTail).toBe(scopeTail);
    expect(printedScope.status).toBe('failed');
    expect(printedScope.exitCode).toBe(1);
    // Only the scope gate carries it.
    const printedWorkEvidence = printed.gates.find(
      (g: VerificationGateResultView) => g.gateId === 'work-evidence'
    );
    expect(printedWorkEvidence.scope).toBeUndefined();
  });

  it('leaves the scope gate untouched when its log is a message rather than a report', async () => {
    // A skipped or detached-contract gate writes a sentence. An empty
    // `admitted` there would read as "the gate looked and admitted nothing",
    // which is the opposite of "the gate never judged anything".
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            gates: [
              workEvidencePassed,
              gate({
                id: 12, gateId: 'scope', status: 'skipped', exitCode: null,
                logTail: 'scope: no contract is attached to this run, so no scope is declared to check.',
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--json']);

    const printed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(printed.gates.find((g: VerificationGateResultView) => g.gateId === 'scope').scope)
      .toBeUndefined();
  });

  it('adds the machine-readable retry record to the JSON (Issue #1772)', async () => {
    mockFetchWithTail([
      { data: { runId: 7 }, status: 202 },
      {
        data: {
          run: run({
            status: 'failed',
            gates: [
              workEvidencePassed,
              gate({
                id: 11, gateId: 'unit', status: 'failed', exitCode: 1, durationMs: 89000,
                logTail: FLAKY_TAIL,
              }),
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--json']);

    const printed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    const unit = printed.gates.find((g: VerificationGateResultView) => g.gateId === 'unit');
    // This is what a flake advisor reads instead of re-parsing the log.
    expect(unit.flaky).toEqual({
      runs: 2,
      outcome: 'flaky',
      exitCodes: [1, 0],
      durationsMs: [45000, 44000],
      verdict: 'fail',
      exit: '1,0',
      duration: '45.0s,44.0s',
    });
    // Added, not substituted: the stored verdict fields are untouched.
    expect(unit.logTail).toBe(FLAKY_TAIL);
    expect(unit.status).toBe('failed');
    expect(unit.exitCode).toBe(1);
    // Only the retried gate carries it.
    expect(
      printed.gates.find((g: VerificationGateResultView) => g.gateId === 'work-evidence').flaky
    ).toBeUndefined();
  });

  it('reports a 409 conflict with the blocking run id', async () => {
    const fetchMock = mockFetchWithTail([
      {
        data: { error: "Verification run 5 is already running for worktree 'wt1'", runningRunId: 5 },
        status: 409,
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    // No polling happened: the run was never started.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("already in progress for 'wt1' (run 5)")
    );
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.SUCCESS);
  });

  it('rejects an invalid worktree ID before any HTTP call', async () => {
    const fetchMock = mockFetchWithTail([]);
    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', '../bad-id']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects --gates that names no gate before any HTTP call', async () => {
    const fetchMock = mockFetchWithTail([]);
    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--gates', ' , ']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid --instance before any HTTP call', async () => {
    const fetchMock = mockFetchWithTail([]);
    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1', '--instance', 'bad instance!']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
