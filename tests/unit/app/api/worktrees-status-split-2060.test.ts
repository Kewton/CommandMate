/**
 * `GET /api/worktrees`: the list / status split and its measurement record
 * (Issue #2060).
 *
 * Two properties are pinned here and they pull in opposite directions:
 *
 *   1. The DEFAULT call — no query parameters, which is what all seven existing
 *      consumers make — must be indistinguishable from what it was before the
 *      split. Same keys on the rows, same top-level keys on the body, and the
 *      tmux work still done.
 *   2. `?includeStatus=0` must actually SKIP the tmux work. Asserting that the
 *      status keys are missing is not enough: a route that computed the status
 *      and then deleted the keys would pass that and save nothing. So the test
 *      asserts on the collaborators — `listSessions` and
 *      `detectWorktreeSessionStatus` are never called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));

const mockWorktrees = [
  { id: 'wt-1', name: 'feature/one', status: 'doing', cliToolId: 'claude', selectedAgents: ['claude'] },
  { id: 'wt-2', name: 'feature/two', status: 'done', cliToolId: 'codex', selectedAgents: ['codex'] },
];

const mockRepositories = [{ id: 'repo-1', name: 'repo-1', path: '/tmp/repo-1' }];

vi.mock('@/lib/db', () => ({
  getWorktrees: vi.fn(() => mockWorktrees),
  getRepositories: vi.fn(() => mockRepositories),
  getMessages: vi.fn(() => []),
  markPendingPromptsAsAnswered: vi.fn(),
  getAgentInstances: vi.fn(() => []),
}));

// Hoisted: `vi.mock` factories run before module-level `const`s are initialised.
const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  detectWorktreeSessionStatus: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));
const { listSessions, detectWorktreeSessionStatus, logDebug, logWarn } = mocks;

vi.mock('@/lib/tmux/tmux', () => ({ listSessions: mocks.listSessions }));

const RUNNING_STATUS = {
  sessionStatusByCli: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true, waitingKind: null, waitingSince: null, awaitingInstruction: false } },
  sessionStatusByInstance: { claude: { isRunning: true, isWaitingForResponse: false, isProcessing: true, waitingKind: null, waitingSince: null, awaitingInstruction: false } },
  isSessionRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
};

vi.mock('@/lib/session/worktree-status-helper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/worktree-status-helper')>();
  return { ...actual, detectWorktreeSessionStatus: mocks.detectWorktreeSessionStatus };
});

vi.mock('@/lib/session/agent-instances-resolver', () => ({
  resolveAgentInstances: vi.fn(() => [{ id: 'claude', cliTool: 'claude', alias: null }]),
}));

vi.mock('@/lib/detection/stalled-detector', () => ({ isWorktreeStalled: vi.fn(() => false) }));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({ debug: mocks.logDebug, info: vi.fn(), warn: mocks.logWarn, error: vi.fn() })),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/worktrees/route';

/** The status keys the route has published on every row since #875. */
const STATUS_KEYS = [
  'sessionStatusByCli',
  'sessionStatusByInstance',
  'isSessionRunning',
  'isWaitingForResponse',
  'isProcessing',
] as const;

async function get(query = '') {
  const res = await GET(new NextRequest(new Request(`http://localhost/api/worktrees${query}`)));
  return { res, body: await res.json() };
}

/** The one `list:timing` record the request emitted. */
function timingRecord(): Record<string, unknown> {
  const call = logDebug.mock.calls.find(([action]) => action === 'list:timing');
  expect(call, 'expected exactly one list:timing debug record').toBeDefined();
  return call![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  listSessions.mockResolvedValue([{ name: 'mcbd-claude-wt-1' }]);
  detectWorktreeSessionStatus.mockResolvedValue(RUNNING_STATUS);
});

describe('[#2060] default call: unchanged', () => {
  it('publishes every status key on every row, exactly as before the split', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.worktrees).toHaveLength(2);
    for (const row of body.worktrees) {
      for (const key of STATUS_KEYS) expect(row).toHaveProperty(key);
      expect(row.agentInstances).toEqual([{ id: 'claude', cliTool: 'claude', alias: null }]);
    }
  });

  it('keeps the top-level body shape to exactly { worktrees, repositories }', async () => {
    // `statusIncluded` is deliberately NOT emitted here: an unconditional new
    // key would change the response of a call no consumer has opted into.
    const { body } = await get();
    expect(Object.keys(body).sort()).toEqual(['repositories', 'worktrees']);
    expect(body.repositories).toEqual(mockRepositories);
  });

  it('still does the tmux work: one batch listSessions, one detect per worktree', async () => {
    await get();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(detectWorktreeSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('is unchanged by a query string that says nothing about status', async () => {
    const { body } = await get('?repository=/tmp/repo-1');
    expect(Object.keys(body).sort()).toEqual(['repositories', 'worktrees']);
    expect(detectWorktreeSessionStatus).toHaveBeenCalledTimes(2);
  });
});

describe('[#2060] ?includeStatus=0: the list without the status', () => {
  it('issues no tmux work at all', async () => {
    await get('?includeStatus=0');
    expect(listSessions).not.toHaveBeenCalled();
    expect(detectWorktreeSessionStatus).not.toHaveBeenCalled();
  });

  it('omits the status keys rather than zeroing them', async () => {
    // Absence, not `false`. A row of `false`s is indistinguishable from a
    // worktree with nothing running and would render a confident `idle` dot.
    const { body } = await get('?includeStatus=0');
    for (const row of body.worktrees) {
      for (const key of STATUS_KEYS) expect(row).not.toHaveProperty(key);
    }
  });

  it('still returns every row, the repositories, and the agent-instance roster', async () => {
    const { body } = await get('?includeStatus=0');
    expect(body.worktrees.map((w: { id: string }) => w.id)).toEqual(['wt-1', 'wt-2']);
    expect(body.repositories).toEqual(mockRepositories);
    expect(body.worktrees[0].agentInstances).toEqual([{ id: 'claude', cliTool: 'claude', alias: null }]);
  });

  it('marks the body so a client can tell "not measured" from "nothing running"', async () => {
    const { body } = await get('?includeStatus=0');
    expect(body.statusIncluded).toBe(false);
  });

  it('drops the review block too, because it is derived from the status', async () => {
    const { body } = await get('?includeStatus=0&include=review');
    for (const row of body.worktrees) {
      expect(row).not.toHaveProperty('nextAction');
      expect(row).not.toHaveProperty('reviewStatus');
      expect(row).not.toHaveProperty('isStalled');
    }
  });

  it('keeps ?include=review working when the status is left on', async () => {
    const { body } = await get('?include=review&includeStatus=1');
    expect(detectWorktreeSessionStatus).toHaveBeenCalledTimes(2);
    for (const row of body.worktrees) {
      expect(row).toHaveProperty('nextAction');
      expect(row).toHaveProperty('reviewStatus');
      expect(row).toHaveProperty('isStalled', false);
    }
  });
});

describe('[#2060] the measurement record', () => {
  it('carries the breakdown, not just a total', async () => {
    await get();
    const rec = timingRecord();

    expect(rec).toMatchObject({
      worktreeCount: 2,
      repositoryCount: 1,
      tmuxSessionCount: 1,
      includeStatus: true,
      includeReview: false,
    });
    for (const key of ['totalMs', 'dbMs', 'statusMs', 'listSessionsMs', 'probeMs']) {
      expect(typeof rec[key], `${key} must be a number`).toBe('number');
      expect(rec[key] as number).toBeGreaterThanOrEqual(0);
    }
    // The point of the split: the two halves add up to the whole.
    expect((rec.dbMs as number) + (rec.statusMs as number)).toBeLessThanOrEqual(rec.totalMs as number);
  });

  it('reports the capture counters, which the caller cannot see any other way', async () => {
    await get();
    const rec = timingRecord();
    // The mocked detect issues no captures; the keys must still be published,
    // because "captures scale with running sessions, not rows" is only visible
    // when captureCount sits beside tmuxSessionCount.
    expect(rec).toHaveProperty('probeCount');
    expect(rec).toHaveProperty('captureCount');
    expect(rec).toHaveProperty('healthCheckCount');
    expect(rec).toHaveProperty('tmuxSessionCount');
  });

  it('zeroes the tmux half of the breakdown when the status was skipped', async () => {
    await get('?includeStatus=0');
    const rec = timingRecord();
    expect(rec).toMatchObject({
      statusMs: 0,
      listSessionsMs: 0,
      probeMs: 0,
      tmuxSessionCount: 0,
      probeCount: 0,
      captureCount: 0,
      healthCheckCount: 0,
      includeStatus: false,
    });
  });

  it('stays at debug for an ordinary request — this route is polled every few seconds', async () => {
    await get();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('is emitted once per request, not once per worktree', async () => {
    await get();
    expect(logDebug.mock.calls.filter(([a]) => a === 'list:timing')).toHaveLength(1);
  });
});
