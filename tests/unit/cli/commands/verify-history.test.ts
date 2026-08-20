/**
 * verify history / verify show tests (Issue #1593).
 *
 * Both output modes are asserted for both subcommands: human output is what a
 * person reads and JSON is what a script parses, and shipping one correct while
 * the other silently prints `[object Object]` is a real failure mode.
 *
 * Read subcommands must never exit 20 or 21 — those codes mean "this worktree
 * failed verification", and a query about past runs is not a verdict.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, VerifyExitCode } from '../../../../src/cli/types';
import type {
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

interface MockResponse {
  data: unknown;
  status?: number;
}

function mockFetch(responses: MockResponse[]) {
  const fn = vi.fn();
  responses.forEach((resp) => {
    const status = resp.status ?? 200;
    fn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(resp.data),
      text: () => Promise.resolve(JSON.stringify(resp.data)),
    });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function summary(over: Partial<VerificationRunSummaryView> = {}): VerificationRunSummaryView {
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
    gates: [{ gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 12_300 }],
    ...over,
  };
}

function detail(over: Partial<VerificationRunView> = {}): VerificationRunView {
  return {
    id: 7,
    worktreeId: 'wt1',
    instanceId: 'codex-2',
    taskId: null,
    trigger: 'manual',
    status: 'failed',
    baseRef: 'origin/develop',
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:01:00.000Z',
    gates: [
      {
        id: 1,
        runId: 7,
        gateId: 'unit',
        command: 'npm run test:unit',
        status: 'failed',
        exitCode: 1,
        durationMs: 45_000,
        logTail: '2 tests failed\nexpected 1 to be 2',
        startedAt: '2026-07-30T00:00:00.000Z',
        finishedAt: '2026-07-30T00:00:45.000Z',
      },
    ],
    ...over,
  };
}

async function loadCommand() {
  const { createVerifyCommand } = await import('../../../../src/cli/commands/verify');
  return createVerifyCommand();
}

/** Every line written to stdout, joined — subcommands print line by line. */
function stdout(): string {
  return mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('verify subcommand registration', () => {
  it('registers history and show without displacing the run action', async () => {
    const cmd = await loadCommand();

    expect(cmd.commands.map((sub) => sub.name()).sort()).toEqual(['history', 'show']);
  });

  it('declares the documented history options', async () => {
    const cmd = await loadCommand();
    const history = cmd.commands.find((sub) => sub.name() === 'history');

    expect(history?.options.map((opt) => opt.long)).toEqual(
      expect.arrayContaining(['--worktree', '--days', '--limit', '--json', '--token'])
    );
  });

  it('still runs a verification when the first operand is a worktree id', async () => {
    const fetchMock = mockFetch([
      { data: { runId: 7 }, status: 202 },
      { data: { run: { ...detail(), status: 'passed', gates: [] } } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'wt1']);

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/worktrees/wt1/verify');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});

describe('verify history — human output', () => {
  it('prints one line per run with date, worktree, trigger and status', async () => {
    mockFetch([{ data: { runs: [summary()] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stdout()).toBe('#7  2026-07-30T00:00:00.000Z  wt1  manual  passed');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('names the failing gates on the line', async () => {
    mockFetch([
      {
        data: {
          runs: [
            summary({
              status: 'failed',
              gates: [
                { gateId: 'lint', status: 'passed', exitCode: 0, durationMs: 100 },
                { gateId: 'unit', status: 'failed', exitCode: 1, durationMs: 200 },
                { gateId: 'build', status: 'timeout', exitCode: null, durationMs: null },
              ],
            }),
          ],
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stdout()).toContain('failed: unit,build');
    expect(stdout()).not.toContain('lint');
  });

  it('does not count a skipped gate as a failure', async () => {
    mockFetch([
      {
        data: {
          runs: [
            summary({
              status: 'error',
              gates: [{ gateId: 'build', status: 'skipped', exitCode: null, durationMs: 0 }],
            }),
          ],
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stdout()).not.toContain('failed:');
  });

  it('prints one line per run for several runs, newest order preserved', async () => {
    mockFetch([
      { data: { runs: [summary({ id: 9 }), summary({ id: 8 }), summary({ id: 7 })] } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(mockConsoleLog).toHaveBeenCalledTimes(3);
    expect(stdout().split('\n').map((line) => line.split('  ')[0])).toEqual(['#9', '#8', '#7']);
  });

  it('reports an empty result on stderr and leaves stdout clean, exiting 0', async () => {
    mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(stderr()).toBe('No verification runs found.');
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('verify history — JSON output', () => {
  it('prints the runs as a parseable JSON array', async () => {
    mockFetch([{ data: { runs: [summary(), summary({ id: 8 })] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--json']);

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(7);
    expect(parsed[0].gates[0].gateId).toBe('lint');
  });

  it('prints an empty array rather than a prose message when nothing matched', async () => {
    mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--json']);

    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toEqual([]);
    expect(mockConsoleError).not.toHaveBeenCalled();
  });
});

describe('--json / --token reach the subcommand even though verify declares them too', () => {
  it('honours --json placed after the history subcommand name', async () => {
    mockFetch([{ data: { runs: [summary()] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--json']);

    // Human output would print `#7  2026-...`; JSON output is a single array.
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(Array.isArray(JSON.parse(mockConsoleLog.mock.calls[0][0] as string))).toBe(true);
  });

  it('honours --json placed after the show subcommand argument', async () => {
    mockFetch([{ data: { run: detail() } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7', '--json']);

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string).id).toBe(7);
  });

  it('sends --token as a bearer header from the history subcommand', async () => {
    const fetchMock = mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--token', 'secret-token']);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token');
  });

  it('sends --token as a bearer header from the show subcommand', async () => {
    const fetchMock = mockFetch([{ data: { run: detail() } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7', '--token', 'secret-token']);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer secret-token');
  });
});

describe('verify history — query building', () => {
  it('sends no query string when no filter is given', async () => {
    const fetchMock = mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history']);

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/verification\/runs$/);
  });

  it('forwards --worktree, --days and --limit as query params', async () => {
    const fetchMock = mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync([
      'node', 'verify', 'history',
      '--worktree', 'wt1', '--days', '14', '--limit', '5',
    ]);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/verification/runs');
    expect(url.searchParams.get('worktreeId')).toBe('wt1');
    expect(url.searchParams.get('days')).toBe('14');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});

describe('verify history — argument validation happens before any HTTP call', () => {
  it.each([
    ['--worktree', '../bad-id'],
    ['--days', '0'],
    ['--days', '91'],
    ['--limit', '0'],
    ['--limit', '501'],
  ])('rejects %s %s with exit 2', async (flag, value) => {
    const fetchMock = mockFetch([]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', flag, value]);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['1', '90'])('accepts --days %s', async (value) => {
    const fetchMock = mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--days', value]);

    expect(mockExit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['1', '500'])('accepts --limit %s', async (value) => {
    const fetchMock = mockFetch([{ data: { runs: [] } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'history', '--limit', value]);

    expect(mockExit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('verify show — human output', () => {
  it('prints the run header and each gate with its log tail', async () => {
    mockFetch([{ data: { run: detail() } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7']);

    const out = stdout();
    expect(out).toContain('run #7  failed  worktree=wt1  trigger=manual');
    expect(out).toContain('started=2026-07-30T00:00:00.000Z  finished=2026-07-30T00:01:00.000Z');
    expect(out).toContain('baseRef=origin/develop  instance=codex-2  task=-');
    expect(out).toContain('unit  failed  exit=1  45.0s');
    expect(out).toContain('| 2 tests failed');
    expect(out).toContain('| expected 1 to be 2');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('renders null exit code and duration as n/a rather than "null"', async () => {
    mockFetch([
      {
        data: {
          run: detail({
            gates: [
              {
                id: 1, runId: 7, gateId: 'build', command: 'npm run build',
                status: 'skipped', exitCode: null, durationMs: null, logTail: null,
                startedAt: '2026-07-30T00:00:00.000Z', finishedAt: null,
              },
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7']);

    expect(stdout()).toContain('build  skipped  exit=n/a  n/a');
    expect(stdout()).not.toContain('null');
  });

  it('names where each gate was declared (Issue #1791)', async () => {
    // `show` is the view a reader consults to reconstruct what a run judged, so
    // "which of these was the repository's own criterion" must not have to be
    // inferred. A gate row from before migration v56 carries no source and
    // prints none, rather than claiming one.
    mockFetch([
      {
        data: {
          run: detail({
            gates: [
              {
                id: 1, runId: 7, gateId: 'lint', command: 'npm run lint',
                status: 'passed', exitCode: 0, durationMs: 1000, logTail: null,
                startedAt: '2026-07-30T00:00:00.000Z', finishedAt: '2026-07-30T00:00:01.000Z',
                source: 'verify.yaml',
              },
              {
                id: 2, runId: 7, gateId: 'issue-1791-repro', command: 'node repro.mjs',
                status: 'failed', exitCode: 3, durationMs: 2000, logTail: null,
                startedAt: '2026-07-30T00:00:01.000Z', finishedAt: '2026-07-30T00:00:03.000Z',
                source: 'contract',
              },
              {
                id: 3, runId: 7, gateId: 'legacy', command: 'npm run legacy',
                status: 'passed', exitCode: 0, durationMs: 3000, logTail: null,
                startedAt: '2026-07-30T00:00:03.000Z', finishedAt: '2026-07-30T00:00:06.000Z',
              },
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7']);

    const out = stdout();
    expect(out).toContain('lint  passed  exit=0  1.0s  src=verify.yaml');
    expect(out).toContain('issue-1791-repro  failed  exit=3  2.0s  src=contract');
    expect(out).toContain('legacy  passed  exit=0  3.0s');
    expect(out).not.toContain('src=undefined');
    expect(out).not.toContain('src=null');
  });

  it('renders a still-running run without inventing a finish time', async () => {
    mockFetch([
      { data: { run: detail({ status: 'running', finishedAt: null, instanceId: null, gates: [] }) } },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7']);

    expect(stdout()).toContain('finished=-');
    expect(stdout()).toContain('instance=-');
  });
});

describe('verify show — JSON output', () => {
  it('prints the run as parseable JSON including gate log tails', async () => {
    mockFetch([{ data: { run: detail() } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7', '--json']);

    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(parsed.id).toBe(7);
    expect(parsed.gates[0].logTail).toContain('2 tests failed');
  });

  it('carries the scope evidence on the forensic surface too (Issue #1841)', async () => {
    // `show` is where a reader reconstructs a run days later — exactly when
    // "which allow pattern let that file through" is asked and the working tree
    // that would answer it has moved on.
    mockFetch([
      {
        data: {
          run: detail({
            gates: [
              {
                id: 2,
                runId: 7,
                gateId: 'scope',
                command: 'git diff --name-only / status --porcelain \u00d7 contract scope',
                status: 'passed',
                exitCode: 0,
                durationMs: 200,
                logTail: [
                  'scope: baseRef=origin/develop changed=1 violations=0',
                  'allow: src/**',
                  'deny: (none)',
                  'admitted:',
                  '  + src/a/b.ts  \u2190 src/**',
                ].join('\n'),
                startedAt: '2026-07-30T00:00:00.000Z',
                finishedAt: '2026-07-30T00:00:00.200Z',
              },
            ],
          }),
        },
      },
    ]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7', '--json']);

    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(parsed.gates[0].scope).toEqual({
      admitted: [{ path: 'src/a/b.ts', pattern: 'src/**' }],
      violations: [],
      totals: { changed: 1, admitted: 1, violations: 0 },
    });
  });
});

describe('verify show — errors', () => {
  it('requests the run by id on the cross-worktree route', async () => {
    const fetchMock = mockFetch([{ data: { run: detail() } }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '7']);

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/verification/runs/7');
  });

  it('names the run, not a worktree, when the server answers 404', async () => {
    mockFetch([{ data: { error: 'Verification run not found' }, status: 404 }]);

    const cmd = await loadCommand();
    await cmd.parseAsync(['node', 'verify', 'show', '4242']);

    expect(stderr()).toContain('Verification run 4242 not found.');
    expect(stderr()).not.toContain('worktree ID');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(mockExit).not.toHaveBeenCalledWith(ExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.VERIFY_FAILED);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });

  it.each(['0', '-1', 'abc', '1.5'])(
    'rejects run id %s with exit 2 before any HTTP call',
    async (value) => {
      const fetchMock = mockFetch([]);

      const cmd = await loadCommand();
      await cmd.parseAsync(['node', 'verify', 'show', value]);

      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
