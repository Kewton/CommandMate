/**
 * Issue #1547: a prompt the autoYes policy withholds must still reach a human.
 *
 * Suppression is only safe if the escalation it implies actually happens, so this
 * exercises both halves against the same pane content:
 *
 * 1. the Auto-Yes poller declines to answer (no keystroke reaches the agent), and
 * 2. the response poller's prompt path records the prompt, broadcasts it over
 *    WebSocket and fans it out to Web Push — the notification the user gets.
 *
 * The second half is existing behaviour (#1125) that this Issue depends on rather
 * than adds, which is exactly why it is pinned here: if that path ever stops
 * notifying, policy suppression silently becomes a stall.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

// --- Auto-Yes poller side effects -----------------------------------------
const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...a: unknown[]) => sendPromptAnswer(...(a as [])),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), stopPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastTerminalSnapshot: vi.fn().mockResolvedValue(undefined),
}));
// Partial, not whole-module: the only thing worth stubbing here is the cache's
// globalThis-backed state. The rest of the module is pure (the capture-window
// width and the saturation predicate #1670 added), and response-checker reads it
// on the path these tests drive — a whole-module replacement silently made those
// undefined and checkForResponse's catch reported the resulting TypeError as an
// ordinary "no response found".
vi.mock('@/lib/tmux/tmux-capture-cache', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>();
  return { ...actual, invalidateCache: vi.fn() };
});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));

// --- response-checker side effects ----------------------------------------
const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn(async () => true);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...(a as [])),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const broadcastMessage = vi.fn();
const notifyPushSubscribers = vi.fn(async () => {});
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...(a as [])),
}));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));

vi.mock('@/lib/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
    getSessionState: () => ({ lastCapturedLine: 0 }),
    updateSessionState: vi.fn(),
    getWorktreeById: () => ({ id: 'wt-1547e', name: 'contract worktree' }),
    clearInProgressMessageId: vi.fn(),
    markPendingPromptsAsAnswered: vi.fn(() => 0),
  };
});

import { createTask } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling as resetResponsePollerCache } from '@/lib/polling/response-poller-core';

const WORKTREE_ID = 'wt-1547e';

/** A Claude pane sitting on a permission prompt, with scrollback above it. */
const PANE = [
  '❯ apply the refactor',
  '',
  '⏺ I need permission to edit the file.',
  '',
  'Do you want to make this edit to useVirtualKeyboard.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

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

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  clearAutoYesPolicyCache();
  resetResponsePollerCache(WORKTREE_ID, 'claude');
  vi.clearAllMocks();
  isSessionRunning.mockResolvedValue(true);
  captureSessionOutput.mockResolvedValue(PANE);

  createTask(db, {
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
autoYes:
  mode: 'off'
`,
      'task.yaml'
    ),
    status: 'running',
  });
});

afterEach(() => {
  db.close();
});

describe('Issue #1547: a policy-suppressed prompt escalates to a human', () => {
  it('the poller sends no answer', async () => {
    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', PANE)).toBe(
      'no_answer'
    );
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('the response poller records the prompt, broadcasts it and pushes it', async () => {
    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);

    const promptMessages = createMessage.mock.calls
      .map(([, message]) => message)
      .filter(message => message.messageType === 'prompt');
    expect(promptMessages).toHaveLength(1);

    expect(broadcastMessage).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ worktreeId: WORKTREE_ID })
    );

    expect(notifyPushSubscribers).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: WORKTREE_ID,
        kind: 'prompt',
        excerpt: expect.stringContaining('useVirtualKeyboard.ts'),
      })
    );
  });

  it('escalation does not depend on the policy — the same prompt notifies either way', async () => {
    // The notification path is independent of Auto-Yes, so a contract-less
    // session behaves identically here. Pinning it keeps a future change from
    // making escalation conditional on suppression.
    clearAutoYesPolicyCache();
    db.prepare('DELETE FROM tasks').run();

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(notifyPushSubscribers).toHaveBeenCalledTimes(1);
  });
});
