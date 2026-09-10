/**
 * A numbered Claude reply reaches History as a reply, and `/prompt-response`
 * will not type at it (Issue #2457).
 *
 * The unit suites in `tests/unit/polling/` prove the gate and its two call
 * sites. What they cannot show is the thing the operator actually saw: a row in
 * `chat_messages` with `message_type = 'prompt'` and a `prompt_data` payload,
 * which is what makes the chat surface draw a tool-approval chip. So this runs
 * the real `checkForResponse` against a real SQLite file and then reads the
 * table back, and it runs the real route against the same database.
 *
 * Only tmux, sockets, push and the transcript reader are stubbed — the
 * detection layer, the extraction, the save path and the DB writes are the
 * shipping ones.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const stubs = vi.hoisted(() => ({
  captureSessionOutput: vi.fn<(...a: unknown[]) => Promise<string>>(),
  captureSessionOutputFresh: vi.fn<(...a: unknown[]) => Promise<string>>(),
  isSessionRunning: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  sendKeys: vi.fn(async () => {}),
  sendSpecialKeys: vi.fn(async () => {}),
  db: { current: null as Database.Database | null },
}));

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => stubs.captureSessionOutput(...a),
  captureSessionOutputFresh: (...a: unknown[]) => stubs.captureSessionOutputFresh(...a),
  isSessionRunning: (...a: unknown[]) => stubs.isSessionRunning(...a),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => stubs.db.current }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
  broadcastTerminalSnapshotAfterInteraction: vi.fn(async () => {}),
}));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: vi.fn(() => false),
  captureStructuredHistoryTurn: vi.fn(async () => false),
}));
// Issue #2317 Phase D asks tmux who owns the pane geometry on every claude poll.
// That is a real child process; left unstubbed the tick settles after the test
// has closed the database.
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: vi.fn(async () => ({ delegated: false, released: false })),
}));
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: (...a: unknown[]) => stubs.sendKeys(...(a as [])),
  sendSpecialKeys: (...a: unknown[]) => stubs.sendSpecialKeys(...(a as [])),
  capturePane: vi.fn(async () => ''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn(async () => ({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  })),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn(async () => true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import type { NextRequest } from 'next/server';
import type { Worktree } from '@/types/models';

const WT = 'wt-2457-int';
const REPLIES = path.resolve(__dirname, '../fixtures/claude-idle-numbered-list-2457');
const DIALOGS = path.resolve(__dirname, '../unit/lib/detection/fixtures/claude-live-1708');

function reply(name: string): string {
  return readFileSync(path.join(REPLIES, `${name}.txt`), 'utf8');
}

function dialog(name: string): string {
  return readFileSync(path.join(DIALOGS, `${name}.txt`), 'utf8');
}

interface StoredRow {
  role: string;
  message_type: string;
  content: string;
  prompt_data: string | null;
}

function storedMessages(): StoredRow[] {
  return stubs.db.current!
    .prepare('SELECT role, message_type, content, prompt_data FROM chat_messages WHERE worktree_id = ? ORDER BY id')
    .all(WT) as StoredRow[];
}

function request(body: Record<string, unknown>): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.db.current = new Database(':memory:');
  runMigrations(stubs.db.current);

  const worktree: Worktree = {
    id: WT,
    name: 'wt-2457-int',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(stubs.db.current, worktree);

  stopPolling(WT, 'claude');
  stubs.isSessionRunning.mockResolvedValue(true);
});

afterEach(() => {
  stopPolling(WT, 'claude');
  stubs.db.current?.close();
  stubs.db.current = null;
});

describe('[#2457] a numbered reply in the chat surface', () => {
  it('is stored as the assistant\'s answer, with no prompt payload', async () => {
    stubs.captureSessionOutput.mockResolvedValue(reply('reply-question-paragraph'));

    expect(await checkForResponse(WT, 'claude')).toBe(true);

    const rows = storedMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    // `message_type` is what the chat surface reads to decide between prose and
    // a tool-approval chip, and `prompt_data` is what fills the chip in.
    expect(rows[0].message_type).toBe('normal');
    expect(rows[0].prompt_data).toBeNull();
    expect(rows[0].content).toContain('cloudflare');
  });

  it('leaves a real permission dialog stored as a prompt', async () => {
    stubs.captureSessionOutput.mockResolvedValue(dialog('bash-approval-taskpanel'));

    expect(await checkForResponse(WT, 'claude')).toBe(true);

    const rows = storedMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0].message_type).toBe('prompt');
    expect(JSON.parse(rows[0].prompt_data ?? 'null')).toMatchObject({ type: 'multiple_choice' });
  });

  it('is not answerable through /prompt-response, and the pane is untouched', async () => {
    stubs.captureSessionOutputFresh.mockResolvedValue(reply('reply-numbered-list-repaint'));

    const response = await promptResponse(request({ answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });

    expect(await response.json()).toEqual({
      success: false,
      reason: 'prompt_no_longer_active',
      answer: '1',
    });
    expect(stubs.sendKeys).not.toHaveBeenCalled();
    expect(stubs.sendSpecialKeys).not.toHaveBeenCalled();
    // #1685's audit trail records an answered prompt; a refusal writes nothing.
    expect(storedMessages()).toEqual([]);
  });

  it('still answers a real dialog through /prompt-response', async () => {
    stubs.captureSessionOutputFresh.mockResolvedValue(dialog('bash-approval-taskpanel'));

    const response = await promptResponse(request({ answer: '1' }), {
      params: Promise.resolve({ id: WT }),
    });

    expect((await response.json()).success).toBe(true);
    expect(stubs.sendSpecialKeys).toHaveBeenCalledWith(`claude-${WT}`, ['Enter']);
    expect(storedMessages().map(r => r.message_type)).toEqual(['prompt']);
  });
});
