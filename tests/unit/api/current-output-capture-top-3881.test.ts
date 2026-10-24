/**
 * Issue #3881, second review N3: `GET /current-output` publishes the same
 * approval-target completeness the Auto-Yes poller acts on, so `observe=1`'s
 * contract re-evaluation and the poller agree on one capture.
 *
 * The poller marks a target whose upward scan reached a top that may be cut
 * (`top-unknown` on a `clipped` / `screen-full` capture) and withholds a deny
 * miss as `deny-pattern-unusable`. The payload published
 * `detectSessionStatus`'s promptData as it was, and `observeSession` resolved
 * the contract on it: `policy-permits` for the screen the poller withheld.
 * Now `current-output-builder` applies the same `captureTopOf` to its own
 * capture window.
 *
 * Both readers run for real on one stubbed capture (only the tmux read, the
 * socket and the session-ownership probe are stubbed), against a real
 * contract in a migrated database.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

/** Swapped per test; the capture mock below reads it at call time. */
let paneFrame = '';

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return { ...actual, captureSessionOutput: vi.fn(async () => paneFrame) };
});
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
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { resolveAutoAnswerWithPolicy } from '@/lib/polling/auto-yes-resolver';
import { FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES } from '@/config/auto-yes-config';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import type { PromptData } from '@/types/models';

const WT = 'wt-3881-observe';

const PROMPT_ROWS = [
  'Do you want to make this edit to cleanup.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
];

/** A 10-row claude pane whose content scrolled: full to its bottom row, the command's top gone. */
const SCROLLED = ['', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS].join('\n');

/** A fresh 1000-row claude pane: the whole dialog on screen, blank rows below. */
const WHOLE = (() => {
  const rows = ['', '     12 +    cleanupTargets(root)', '     13 +    return root', '     14 +  }', '', ...PROMPT_ROWS];
  return [...rows, ...Array<string>(TUI_PANE_HEIGHT - rows.length).fill('')].join('\n');
})();

const DENY = { mode: null, allowPromptTypes: [], denyPatterns: ['rm -rf'] };

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

/** The poller's tick on `frame` under `window`, and the reason it recorded. */
async function pollerVerdict(frame: string, window: number) {
  clearPolicySuppressions();
  clearAllPollerStates();
  const result = await detectAndRespondToPrompt(
    WT, pollerState(), 'claude', frame, frame.split('\n'), undefined, frame, undefined, undefined, window,
  );
  return { result, reason: getLastPolicySuppression(WT, 'claude', undefined)?.reason ?? null };
}

/** `GET /current-output?observe=1` on `frame`. */
async function observed(frame: string) {
  paneFrame = frame;
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
  vi.spyOn(CLIToolManager.getInstance().getTool('claude'), 'isRunning').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setMockDb(null);
  db.close();
});

describe('[#3881 N3] observe=1 and the poller read one capture the same way', () => {
  it('a scrolled screen: the payload says top-unknown, and both withhold as deny-pattern-unusable', async () => {
    const body = await observed(SCROLLED);
    expect(body.promptData?.approvalTargetCompleteness).toBe('top-unknown');
    expect(body.promptObservation.autoYes.contractEvaluation).toMatchObject({
      state: 'policy-withholds',
      reason: 'deny-pattern-unusable',
    });
    for (const window of [FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES]) {
      expect(await pollerVerdict(SCROLLED, window)).toEqual({ result: 'no_answer', reason: 'deny-pattern-unusable' });
    }
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('陰性対照: the whole screen: nothing added, and both answer', async () => {
    const body = await observed(WHOLE);
    expect(body.promptData).not.toBeNull();
    expect(body.promptData).not.toHaveProperty('approvalTargetCompleteness');
    expect(body.promptObservation.autoYes.contractEvaluation).toMatchObject({ state: 'policy-permits' });
    for (const window of [FULL_CAPTURE_LINES, REDUCED_CAPTURE_LINES]) {
      expect((await pollerVerdict(WHOLE, window)).result).toBe('responded');
    }
  });

  it('陽性対照: the status detector’s promptData as the payload published it (pre-fix) permits', () => {
    const promptData = detectSessionStatus(SCROLLED, 'claude').promptDetection.promptData!;
    expect(promptData).not.toHaveProperty('approvalTargetCompleteness');
    expect(resolveAutoAnswerWithPolicy(promptData, DENY, 'claude')).toMatchObject({ suppressedBy: null });
  });
});
