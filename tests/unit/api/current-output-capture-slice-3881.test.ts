/**
 * Issue #3881, third review N4: `GET /current-output` and the Auto-Yes poller
 * judge one tmux capture the same way when it goes through the real capture
 * layer — the terminator tmux ends every row with, and the cache's slice.
 *
 * `current-output-capture-top-3881.test.ts` stands in for
 * `captureSessionOutput` and hands both readers a frame without tmux's
 * terminator, so it could not see that the poller's 1000-row window lost a
 * 1000-row screen's first row while this route's 10000-row window kept it:
 * the whole screen was published as answerable and withheld by the poller,
 * and a screen whose lost first row was the denied command was answered by
 * the poller. Here only the transport's `captureSnapshot` (tmux's raw output)
 * is stood in for; the route, `captureSessionOutput`, the capture cache and
 * the poller's `capturePollerFrame` run for real, against a real contract in
 * a migrated database.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

/** tmux's raw `capture-pane` output for the session, swapped per test. */
const pane = vi.hoisted(() => ({ raw: '' }));
vi.mock('@/lib/tmux/polling-tmux-transport', () => ({
  getPollingTmuxTransport: () => ({
    sessionExists: async () => true,
    captureSnapshot: async () => pane.raw,
  }),
}));
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  hasRoomSubscribers: vi.fn(() => false),
}));
vi.mock('@/lib/cli-tools/session-ownership', () => ({
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'own' })),
  foreignSessionErrorBody: vi.fn(),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database | null): void;
}
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database | null) => {
      mockDb = db;
    },
  };
});

import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, upsertWorktree } from '@/lib/db';
import { setMockDb } from '@/lib/db/db-instance';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import { detectAndRespondToPrompt, clearAllPollerStates, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { capturePollerFrame } from '@/lib/polling/auto-yes-poller-capture';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import type { PromptData } from '@/types/models';

const WT = 'wt-3881-observe-slice';

const PROMPT_ROWS = [
  'Do you want to make this edit to cleanup.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
];
const DENIED_ROW = '     11 +    execSync(`rm -rf ${root}`)';

/** `rows`, padded with blank rows to `height`, as tmux returns them: every row ends with a newline. */
function tmuxRaw(rows: readonly string[], height: number): string {
  return `${[...rows, ...Array<string>(height - rows.length).fill('')].join('\n')}\n`;
}

/** A fresh 1000-row claude pane: the top margin row, the dialog, blank rows to the bottom. */
const WHOLE = tmuxRaw(['', '     12 +    cleanupTargets(root)', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS], TUI_PANE_HEIGHT);

/** A 1000-row claude pane whose first row is the denied command, a blank row under it. */
const DENIED_FIRST = tmuxRaw([DENIED_ROW, '', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS], TUI_PANE_HEIGHT);

/** A pane one row taller than the poller's REDUCED window, the denied command on its first row. */
const TALLER = tmuxRaw(
  [DENIED_ROW, '', '', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS],
  TUI_PANE_HEIGHT + 1,
);

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** The poller's tick on `raw` under `window`, captured as `pollAutoYes` captures it. */
async function pollerVerdict(raw: string, window: number) {
  pane.raw = raw;
  resetCacheForTesting();
  clearPolicySuppressions();
  clearAllPollerStates();
  const frame = await capturePollerFrame(WT, 'claude', window);
  const result = await detectAndRespondToPrompt(
    WT, pollerState(), 'claude', frame.clean, frame.clean.split('\n'), undefined, frame.raw, undefined, undefined,
    window, frame.headCut,
  );
  return { result, reason: getLastPolicySuppression(WT, 'claude', undefined)?.reason ?? null };
}

/** `GET /current-output?observe=1` on `raw`. */
async function observed(raw: string) {
  pane.raw = raw;
  resetCacheForTesting();
  const response = await GET(
    new NextRequest(`http://localhost:3000/api/worktrees/${WT}/current-output?observe=1`),
    { params: Promise.resolve({ id: WT }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    promptData: (PromptData & { approvalTargetCompleteness?: string }) | null;
    promptObservation: { autoYes: { contractEvaluation: { state: string; reason?: string } } };
  };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'observe',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
  });
  createTask(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      "version: 1\ntitle: a task\ngoal: do the thing\nscope:\n  allow: [\"src/**\"]\nautoYes:\n  denyPatterns: ['rm -rf']\n",
      'task.yaml',
    ),
    status: 'running',
  });
  clearAutoYesPolicyCache();
  sendPromptAnswer.mockClear();
  resetCacheForTesting();
  vi.spyOn(CLIToolManager.getInstance().getTool('claude'), 'isRunning').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCacheForTesting();
  setMockDb(null);
  db.close();
});

describe('[#3881 N4] one raw tmux capture through the real capture layer', () => {
  it('the whole screen: the payload permits, and the poller answers under both windows', async () => {
    const body = await observed(WHOLE);
    expect(body.promptData).not.toBeNull();
    expect(body.promptData).not.toHaveProperty('approvalTargetCompleteness');
    expect(body.promptObservation.autoYes.contractEvaluation).toMatchObject({ state: 'policy-permits' });
    for (const window of [FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES]) {
      expect(await pollerVerdict(WHOLE, window)).toEqual({ result: 'responded', reason: null });
    }
  });

  it('the denied command on the first row: the payload withholds, and the poller does not answer under either window', async () => {
    const body = await observed(DENIED_FIRST);
    expect(body.promptObservation.autoYes.contractEvaluation.state).toBe('policy-withholds');
    for (const window of [FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES]) {
      const verdict = await pollerVerdict(DENIED_FIRST, window);
      expect(verdict.result).toBe('no_answer');
      expect(['deny-pattern', 'deny-pattern-unusable']).toContain(verdict.reason);
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('a pane taller than the REDUCED window: whichever window keeps the denied row denies it, the one that cut it withholds', async () => {
    const body = await observed(TALLER);
    expect(body.promptObservation.autoYes.contractEvaluation.state).toBe('policy-withholds');
    expect(await pollerVerdict(TALLER, FULL_CAPTURE_LINES)).toEqual({ result: 'no_answer', reason: 'deny-pattern' });
    expect(await pollerVerdict(TALLER, REDUCED_CAPTURE_LINES)).toEqual({
      result: 'no_answer',
      reason: 'deny-pattern-unusable',
    });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});
