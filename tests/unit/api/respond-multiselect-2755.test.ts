/**
 * The legacy `/respond` route and a CHECKBOX answer (Issue #2755 確定仕様 5).
 *
 * This route answers a STORED prompt row, and its multiple-choice branch turns
 * the answer into a number with `parseInt(answer, 10)`. On a checkbox payload
 * that is a silent data loss: `parseInt('1,3', 10)` is `1`, so a request naming
 * two boxes reached `sendPromptAnswer` as the single number `1`, ticked one box,
 * left the question on screen — and this route answered `success: true`.
 *
 * It is not given the toggle-and-confirm arm: that needs a fresh capture to
 * compute the symmetric difference against, and this route deliberately has
 * none (it answers a row, not a screen). So it refuses and points at the route
 * that does. Minimal by design — the Issue asks for the hole closed, not for a
 * second implementation of the send.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Command Code',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) =>
          `cm-${id}-${instanceId ?? 'command-code'}`,
      }),
    })),
  },
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (database: Database.Database) => { mockDb = database; },
    closeDbInstance: () => { mockDb = null; },
  };
});

import { POST as respond } from '@/app/api/worktrees/[id]/respond/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import type { ChatMessage, MultipleChoicePromptData, Worktree } from '@/types/models';

const WT = 'wt-2755-legacy-respond';

let db: Database.Database;

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, { params: Promise.resolve({ id: WT }) }) as unknown as Promise<Response>;
}

function promptRow(promptData: MultipleChoicePromptData): ChatMessage {
  return createMessage(db, {
    worktreeId: WT,
    cliToolId: 'command-code',
    role: 'assistant',
    content: promptData.question,
    messageType: 'prompt',
    promptData,
    timestamp: new Date(),
  } as unknown as ChatMessage);
}

const CHECKBOX: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which caches should I clear?',
  multiSelect: true,
  options: [
    { number: 1, label: 'node_modules', isDefault: true, checked: false },
    { number: 2, label: 'dist', isDefault: false, checked: false },
    { number: 3, label: 'coverage', isDefault: false, checked: false },
  ],
  status: 'pending',
};

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'Legacy respond',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
});

describe('[#2755] `/respond` refuses a checkbox answer instead of truncating it', () => {
  it('rejects "1,3" with 400 and sends no key at all', async () => {
    const message = promptRow(CHECKBOX);

    const response = await post({ messageId: message.id, answer: '1,3' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('checkbox question');
    // The whole point: `1` is what used to go out.
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
  });

  it('names the route that can answer it', async () => {
    const message = promptRow(CHECKBOX);
    const response = await post({ messageId: message.id, answer: '2,3' });
    const body = await response.json();

    expect(body.error).toContain('/prompt-response');
    expect(body.error).toContain('"answers"');
  });

  it('leaves the prompt row unanswered', async () => {
    // A refusal that marked the row answered would take the question off every
    // surface while the agent is still blocked on it.
    const message = promptRow(CHECKBOX);
    await post({ messageId: message.id, answer: '1,3' });

    const row = db
      .prepare('SELECT prompt_data FROM chat_messages WHERE id = ?')
      .get(message.id) as { prompt_data: string };
    expect(JSON.parse(row.prompt_data).status).toBe('pending');
  });
});

describe('[#2755] the guard is scoped to a multi-number answer', () => {
  it('lets a single number through to the sender, which verifies before confirming', async () => {
    // Deliberately still allowed: one number is not truncated by `parseInt`,
    // so the silent loss this guard is about cannot happen. What it meets
    // instead is the sender's checkbox arm, which re-reads the pane, cannot
    // verify anything against it here, and refuses — the answer is reported as
    // a failure rather than as a `success: true` over a question still on
    // screen, which is the behaviour the whole Issue is about.
    const message = promptRow(CHECKBOX);

    const response = await post({ messageId: message.id, answer: '2' });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain('was not submitted');
    // Whatever else happened, the confirm row was never pressed.
    const keys = vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1]).flat();
    expect(keys).not.toContain('Enter');
  });

  it('does not touch a comma answer on a prompt that is not a checkbox question', async () => {
    // The refusal that comes back here is #2583's — free text at a screen with
    // no text field — not this Issue's. That is the assertion: the guard reads
    // `multiSelect`, so every other prompt keeps the verdict it had.
    const { multiSelect: _multiSelect, ...singleSelect } = CHECKBOX;
    const message = promptRow(singleSelect as MultipleChoicePromptData);

    const response = await post({ messageId: message.id, answer: 'dist, coverage' });
    const body = await response.json();

    expect(body.error).not.toContain('checkbox question');
    expect(body.error).toContain('none of its 3 options is a text field');
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });
});
