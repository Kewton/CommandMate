/**
 * The held count in `relays`, `task show` and `report metrics`, text and JSON
 * (Issue #4082, work item b).
 *
 * `heldCount` is its own axis: printed beside the per-state counts, never
 * added to them, and — when an older server does not answer it — not printed
 * at all (never as 0) and `null` in JSON. `task show --json` used to return
 * before the relay counts were read; it now carries them.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const COUNTS = { pending: 2, delivered: 5, prompt: 1, expired: 3, cancelled: 4 };

const TASK = {
  id: TASK_ID,
  worktreeId: 'wt1',
  cliToolId: 'codex',
  instanceId: 'codex',
  title: 'loader work',
  goal: 'do the work',
  contractPath: null,
  contract: {
    version: 1,
    title: 'loader work',
    goal: 'do the work',
    scope: { allow: ['src/**'], deny: [] },
    verify: { gates: ['lint'] },
    autoYes: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] },
    success: { requireWorkEvidence: true, requireScopeClean: true },
  },
  status: 'running',
  lastVerificationRunId: null,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};

const METRICS = {
  periodDays: 7,
  tasks: { total: 0, succeeded: 0, failed: 0, notStarted: 0, cancelled: 0, successRate: null, avgRetryLoops: null },
  verification: { runs: 0, passed: 0, failed: 0, notStarted: 0, passRate: null, gateFailBreakdown: [] },
  intervention: { humanResponds: 0, autoAnswered: 0, suppressedByPolicy: null },
};

/** Answer by URL; the relay list with or without `heldCount`. */
function serve(relayList: Record<string, unknown>): Array<string> {
  const urls: string[] = [];
  global.fetch = vi.fn().mockImplementation((url: string) => {
    urls.push(url);
    let data: unknown = {};
    if (url.includes('/api/relays')) data = relayList;
    else if (url.includes(`/api/tasks/${TASK_ID}`)) data = { task: TASK, lastVerificationRun: null };
    else if (url.includes('/api/metrics/vibe')) data = { metrics: METRICS };
    else if (url.includes('/api/capabilities')) data = { serverVersion: '0.0.0-test', capabilities: [] };
    return Promise.resolve({
      ok: true,
      status: 200,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
  return urls;
}

const logged = () => mockConsoleLog.mock.calls.map((call) => String(call[0])).join('\n');
const errored = () => mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');

const WITH_HELD = { owed: [], awaiting: [], open: [], held: [], counts: COUNTS, heldCount: 3 };
const OLDER = { owed: [], awaiting: [], open: [], counts: COUNTS };

async function task(argv: string[]) {
  const { createTaskCommand } = await import('../../../../src/cli/commands/task');
  await createTaskCommand().parseAsync(['node', 'task', ...argv]);
}

async function report(argv: string[]) {
  const { createReportCommand } = await import('../../../../src/cli/commands/report');
  await createReportCommand().parseAsync(['node', 'report', ...argv]);
}

async function relays(argv: string[]) {
  const { createRelaysCommand } = await import('../../../../src/cli/commands/relays');
  await createRelaysCommand().parseAsync(['node', 'relays', ...argv]);
}

describe('task show (Issue #4082)', () => {
  it('prints the held count beside the open count', async () => {
    const urls = serve(WITH_HELD);
    await task(['show', TASK_ID]);
    expect(logged()).toContain('RELAYS:    5 delivered / 1 prompt / 3 expired  (2 open, 3 held)');
    expect(urls.some((url) => url.includes('/api/relays?worktree=wt1&instance=codex'))).toBe(true);
  });

  it('negative control: an older server prints the line as before, with no held count (never 0)', async () => {
    serve(OLDER);
    await task(['show', TASK_ID]);
    expect(logged()).toContain('RELAYS:    5 delivered / 1 prompt / 3 expired  (2 open)');
    expect(logged()).not.toContain('held');
  });

  it('--json carries the relay counts and the held count (it used to return before reading them)', async () => {
    serve(WITH_HELD);
    await task(['show', TASK_ID, '--json']);
    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(json.task.id).toBe(TASK_ID);
    expect(json.relays).toEqual(COUNTS);
    expect(json.relaysHeld).toBe(3);
  });

  it('--json from an older server: relaysHeld is null, not 0', async () => {
    serve(OLDER);
    await task(['show', TASK_ID, '--json']);
    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(json.relays).toEqual(COUNTS);
    expect(json.relaysHeld).toBeNull();
  });
});

describe('report metrics (Issue #4082)', () => {
  it('prints the held count now, apart from the window', async () => {
    serve(WITH_HELD);
    await report(['metrics']);
    expect(logged()).toContain('(2 still open, 4 cancelled, 3 held now)');
  });

  it('negative control: an older server prints no held count', async () => {
    serve(OLDER);
    await report(['metrics']);
    expect(logged()).toContain('(2 still open, 4 cancelled)');
    expect(logged()).not.toContain('held');
  });

  it('--json carries relays and relaysHeld', async () => {
    serve(WITH_HELD);
    await report(['metrics', '--json']);
    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0]));
    expect(json.relays).toEqual(COUNTS);
    expect(json.relaysHeld).toBe(3);

    mockConsoleLog.mockClear();
    serve(OLDER);
    await report(['metrics', '--json']);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0][0])).relaysHeld).toBeNull();
  });
});

describe('relays (Issue #4082)', () => {
  it('prints held=<n> after the states', async () => {
    serve(WITH_HELD);
    await relays(['--worktree', 'wt-a', '--instance', 'claude']);
    expect(errored()).toContain('relays: pending=2 prompt=1 delivered=5 expired=3 cancelled=4 held=3');
  });

  it('negative control: an older server prints no held=', async () => {
    serve(OLDER);
    await relays(['--worktree', 'wt-a', '--instance', 'claude']);
    expect(errored()).toContain('relays: pending=2 prompt=1 delivered=5 expired=3 cancelled=4');
    expect(errored()).not.toContain('held=');
  });

  it('--json passes heldCount through', async () => {
    serve(WITH_HELD);
    await relays(['--worktree', 'wt-a', '--instance', 'claude', '--json']);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0][0])).heldCount).toBe(3);
  });
});
