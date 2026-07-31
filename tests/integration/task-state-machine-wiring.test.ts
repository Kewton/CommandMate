/**
 * Issue #1548: the firing points move a contracted task, and move nothing else.
 *
 * The state machine and the transition service are unit-tested elsewhere. What
 * this pins is the wiring: that the real send / prompt-detection / auto-answer /
 * human-answer paths raise the events they are supposed to, in order, against
 * the task that actually governs the instance — and that a session with no
 * contract produces an identical outcome with an empty task_events table.
 *
 * The contract-less regression is the point of the Issue. Every one of these
 * paths runs constantly for users who have never written a contract, so a
 * firing point that misfires there is not a logging bug, it is a behaviour
 * change to the product's default mode.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...a: unknown[]) => sendPromptAnswer(...(a as [])),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), stopPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastTerminalSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        getSessionName: (id: string) => `claude-${id}`,
        name: 'Claude',
        isRunning: async () => true,
      }),
    }),
  },
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const captureSessionOutputFresh = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn(async () => true);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  captureSessionOutputFresh: (...a: unknown[]) => captureSessionOutputFresh(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...(a as [])),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));

vi.mock('@/lib/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
    getSessionState: () => ({ lastCapturedLine: 0 }),
    updateSessionState: vi.fn(),
    getWorktreeById: () => ({ id: WORKTREE_ID, name: 'contract worktree', cliToolId: 'claude' }),
    clearInProgressMessageId: vi.fn(),
    markPendingPromptsAsAnswered: vi.fn(() => 0),
  };
});

import { createTask, getTask, listTaskEvents, type Task } from '@/lib/db';
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling as resetResponsePollerCache } from '@/lib/polling/response-poller-core';

const WORKTREE_ID = 'wt-1548';

const asReq = (req: Request) => req as unknown as NextRequest;

/** Two distinct panes: the response poller dedups identical prompt content. */
function pane(question: string): string {
  return [
    '❯ apply the refactor',
    '',
    '⏺ I need permission to edit the file.',
    '',
    question,
    '❯ 1. Yes',
    '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No',
    '',
    'Esc to cancel · Tab to amend',
  ].join('\n');
}

const PANE_A = pane('Do you want to make this edit to alpha.ts?');
const PANE_B = pane('Do you want to make this edit to beta.ts?');

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

function seedTask(): Task {
  return createTask(db, {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude',
    instanceId: null,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
`,
      'task.yaml'
    ),
    status: 'pending',
  });
}

/** Detection state is per-poller-key; clear it so the next pane is not deduped. */
function resetDetection(): void {
  resetResponsePollerCache(WORKTREE_ID, 'claude');
  clearAutoYesPolicyCache();
}

async function patchTask(taskId: string, status: string) {
  const { PATCH } = await import('@/app/api/tasks/[taskId]/route');
  return PATCH(
    asReq(
      new Request(`http://localhost/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    ),
    { params: Promise.resolve({ taskId }) }
  );
}

async function cancelTask(taskId: string) {
  const { POST } = await import('@/app/api/tasks/[taskId]/cancel/route');
  return POST(asReq(new Request(`http://localhost/api/tasks/${taskId}/cancel`, { method: 'POST' })), {
    params: Promise.resolve({ taskId }),
  });
}

async function humanRespond(answer = '1') {
  const { POST } = await import('@/app/api/worktrees/[id]/prompt-response/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${WORKTREE_ID}/prompt-response`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer, cliTool: 'claude' }),
      })
    ),
    { params: Promise.resolve({ id: WORKTREE_ID }) }
  );
}

function events(taskId: string) {
  return listTaskEvents(db, taskId).map(e => [e.event, e.toStatus]);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  resetDetection();
  vi.clearAllMocks();
  isSessionRunning.mockResolvedValue(true);
  captureSessionOutput.mockResolvedValue(PANE_A);
  captureSessionOutputFresh.mockResolvedValue(PANE_A);
});

afterEach(() => {
  db.close();
});

describe('a contracted task walks the whole lifecycle', () => {
  it('records send, prompt, auto-answer, prompt, human answer in order', async () => {
    const task = seedTask();

    expect((await patchTask(task.id, 'running')).status).toBe(200);
    expect(getTask(db, task.id)?.status).toBe('running');

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(getTask(db, task.id)?.status).toBe('waiting_input');

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PANE_A)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(getTask(db, task.id)?.status).toBe('running');

    resetDetection();
    captureSessionOutput.mockResolvedValue(PANE_B);
    captureSessionOutputFresh.mockResolvedValue(PANE_B);

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(getTask(db, task.id)?.status).toBe('waiting_input');

    expect((await humanRespond()).status).toBe(200);
    expect(getTask(db, task.id)?.status).toBe('running');

    expect(events(task.id)).toEqual([
      ['message_sent', 'running'],
      ['prompt_detected', 'waiting_input'],
      ['prompt_answered_auto', 'running'],
      ['prompt_detected', 'waiting_input'],
      ['prompt_answered_human', 'running'],
    ]);
  });

  it('records the prompt type each event was about', async () => {
    const task = seedTask();
    await patchTask(task.id, 'running');
    await checkForResponse(WORKTREE_ID, 'claude');

    expect(listTaskEvents(db, task.id).at(-1)?.payload).toEqual({
      promptType: 'multiple_choice',
    });
  });

  it('closes the task through the cancel route', async () => {
    const task = seedTask();
    await patchTask(task.id, 'running');

    expect((await cancelTask(task.id)).status).toBe(200);
    expect(getTask(db, task.id)?.status).toBe('cancelled');
    expect(events(task.id)).toEqual([
      ['message_sent', 'running'],
      ['cancel', 'cancelled'],
    ]);
  });
});

describe('events that must not take', () => {
  it('records a prompt detected mid-verification as refused, and holds the status', async () => {
    const task = seedTask();
    updateTaskStatus(db, task.id, 'verifying');

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);

    // The prompt was still saved and broadcast — only the task did not move.
    expect(createMessage).toHaveBeenCalled();
    expect(getTask(db, task.id)?.status).toBe('verifying');
    expect(events(task.id)).toEqual([['prompt_detected', null]]);
  });

  it('refuses to reopen a task the gates already passed', async () => {
    const task = seedTask();
    updateTaskStatus(db, task.id, 'succeeded');

    const response = await patchTask(task.id, 'running');
    expect(response.status).toBe(409);
    expect(getTask(db, task.id)?.status).toBe('succeeded');
    // A closed task is no longer active, so the poller paths do not even reach
    // the machine — only the id-addressed PATCH records the refusal.
    expect(events(task.id)).toEqual([['message_sent', null]]);
  });

  it('409s a second cancel instead of reporting success twice', async () => {
    const task = seedTask();
    expect((await cancelTask(task.id)).status).toBe(200);

    const second = await cancelTask(task.id);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: 'Task is already cancelled and cannot be cancelled',
    });
  });
});

describe('a session with no contract is untouched', () => {
  it('detects, answers and responds exactly as before, writing no events', async () => {
    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(1);

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PANE_A)).toBe(
      'responded'
    );
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);

    resetDetection();
    captureSessionOutputFresh.mockResolvedValue(PANE_B);
    expect((await humanRespond()).status).toBe(200);
    expect(sendPromptAnswer).toHaveBeenCalledTimes(2);

    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
  });

  it('leaves a task belonging to a different instance alone', async () => {
    // The contract was sent to codex-2; the claude session prompting here is a
    // different agent and must not be recorded against it.
    const other = createTask(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      contractPath: '.commandmate/tasks/t.yaml',
      contract: parseTaskContract(
        'version: 1\ntitle: other\ngoal: other work\nscope:\n  allow: ["src/**"]\n',
        'task.yaml'
      ),
      status: 'running',
    });

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);

    expect(getTask(db, other.id)?.status).toBe('running');
    expect(listTaskEvents(db, other.id)).toHaveLength(0);
  });
});
