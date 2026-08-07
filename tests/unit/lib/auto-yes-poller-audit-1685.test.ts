/**
 * Issue #1685: the Auto-Yes poller must leave an audit trail in chat history.
 *
 * Before this Issue, an auto-answered prompt could vanish without a trace: if
 * the answer landed inside the response poller's interval, the prompt was never
 * saved as a message, and `capture --json`'s promptData was already null by the
 * time a supervisor looked. These tests drive the real `detectAndRespondToPrompt`
 * against a real migrated database and assert the persisted row — both the
 * "never saved" (create) and "already saved as pending" (update) sides.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async () => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (...args: unknown[]) => sendPromptAnswer(...(args as [])),
}));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...(args as [])),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));

import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import type { PromptData, Worktree } from '@/types/models';
import { answerablePromptOf } from '../../helpers/prompt-type-guards';

const WORKTREE_ID = 'wt-1685';
const FRAME = buildClaude1000RowPermissionFrame();

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

/** The prompt exactly as the poller will detect it on FRAME. */
function detectedPromptData(): PromptData {
  const detection = detectPrompt(FRAME, buildDetectPromptOptions('claude'));
  expect(detection.isPrompt).toBe(true);
  return detection.promptData!;
}

function promptRows() {
  return getMessages(db, WORKTREE_ID, { messageType: 'prompt' });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'Audit',
    path: '/test/wt-1685',
    repositoryPath: '/test/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
  sendPromptAnswer.mockClear();
  broadcastMessage.mockClear();
});

afterEach(() => {
  db.close();
});

describe('detectAndRespondToPrompt audit trail (Issue #1685)', () => {
  it('creates an answered prompt row when the prompt was never saved (sub-interval race)', async () => {
    expect(promptRows()).toHaveLength(0);

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );

    const rows = promptRows();
    expect(rows).toHaveLength(1);
    const promptData = rows[0].promptData!;
    const sentAnswer = (sendPromptAnswer.mock.calls[0] as unknown[])[0] as { answer: string };
    expect(promptData).toMatchObject({
      status: 'answered',
      answeredBy: 'auto',
      answer: sentAnswer.answer,
      question: detectedPromptData().question,
    });
    expect(answerablePromptOf(promptData)!.answeredAt).toBeTruthy();
    expect((promptData as { options: unknown[] }).options.length).toBeGreaterThan(0);
    expect(rows[0].instanceId).toBe('claude');

    // The WS push is fire-and-forget (not awaited by the poller), so wait for it.
    await vi.waitFor(() => {
      expect(broadcastMessage).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ worktreeId: WORKTREE_ID })
      );
    });
  });

  it('updates the pending row in place when the response poller saved it first', async () => {
    const pending = createMessage(db, {
      worktreeId: WORKTREE_ID,
      role: 'assistant',
      content: 'permission prompt',
      messageType: 'prompt',
      promptData: detectedPromptData(),
      timestamp: new Date(),
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    expect(await detectAndRespondToPrompt(WORKTREE_ID, pollerState(), 'claude', FRAME)).toBe(
      'responded'
    );

    const rows = promptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending.id);
    expect(rows[0].promptData).toMatchObject({ status: 'answered', answeredBy: 'auto' });

    await vi.waitFor(() => {
      expect(broadcastMessage).toHaveBeenCalledWith(
        'message_updated',
        expect.objectContaining({ worktreeId: WORKTREE_ID })
      );
    });
  });
});
