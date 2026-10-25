/**
 * Issue #3881 (the second half, review item (5c)): `/respond` answering a
 * stored prompt row keeps what the row says about its screen.
 *
 * The route rewrites the row's `promptData` (status, answer, answeredBy). A
 * row saved with a `reading` keeps it; a row saved before #3881 has none, and
 * none can be made here — the route holds the stored strings and no frame,
 * and reading those again is the re-derivation #3881 removed. So the old row
 * stays an old row and the chat surface reads it with its compatibility rules,
 * the same way after the answer as before it.
 *
 * Negative controls throughout: the kind the chat draws is the same before and
 * after the answer, for both rows.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
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
vi.mock('@/lib/prompt-answer-sender', () => ({ sendPromptAnswer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) => `cm-${id}-${instanceId ?? 'claude'}`,
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
import { upsertWorktree, createMessage, getMessageById } from '@/lib/db';
import { toToolApprovalEntry } from '@/lib/chat/chat-tool-approvals';
import type { ChatMessage, MultipleChoicePromptData, Worktree } from '@/types/models';
import { PROMPT_READING_VERSION, type PromptReading } from '@/types/prompt-reading';

const WT = 'wt-3881-respond';

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
    cliToolId: 'claude',
    role: 'assistant',
    content: promptData.question,
    messageType: 'prompt',
    promptData,
    timestamp: new Date(),
  } as unknown as ChatMessage);
}

/** The 16-column confirm page's stored strings: option 1 cut to `Submit` (#3881's N2 shape). */
const CONFIRM_PAGE_STRINGS: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'should the scope be? → Narrow Ready to submit your answers?',
  options: [
    { number: 1, label: 'Submit', isDefault: true },
    { number: 2, label: 'Cancel', isDefault: false },
  ],
  status: 'pending',
};

const CONFIRMATION_READING: PromptReading = {
  version: PROMPT_READING_VERSION,
  kind: 'confirmation',
  phase: 'confirmation',
  approvalTarget: 'not-measured',
  evidence: ['confirm-page-reader'],
};

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'respond 3881',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
});

describe('[#3881 (5c)] /respond keeps the row\'s reading as it was', () => {
  it('a row with a reading keeps it, and the chat still draws the confirm page', async () => {
    const message = promptRow({ ...CONFIRM_PAGE_STRINGS, reading: CONFIRMATION_READING });
    const before = toToolApprovalEntry(message);
    expect(before).toMatchObject({ kind: 'question', phase: 'confirmation', classifiedFrom: 'reading' });

    const response = await post({ messageId: message.id, answer: '1' });
    expect(response.status).toBe(200);

    const after = getMessageById(db, message.id)!;
    expect(after.promptData).toMatchObject({ status: 'answered', answer: '1', answeredBy: 'human' });
    expect((after.promptData as MultipleChoicePromptData).reading).toEqual(CONFIRMATION_READING);
    expect(toToolApprovalEntry(after)).toMatchObject({ kind: 'question', phase: 'confirmation', classifiedFrom: 'reading' });
  });

  it('a row saved before #3881 stays without one: no reading is made from its strings', async () => {
    const message = promptRow(CONFIRM_PAGE_STRINGS);
    const before = toToolApprovalEntry(message);
    expect(before.classifiedFrom).toBeUndefined();

    const response = await post({ messageId: message.id, answer: '1' });
    expect(response.status).toBe(200);

    const after = getMessageById(db, message.id)!;
    expect('reading' in (after.promptData as object)).toBe(false);
    // The compatibility rules read it after the answer exactly as before it.
    const entry = toToolApprovalEntry(after);
    expect(entry.classifiedFrom).toBeUndefined();
    expect({ kind: entry.kind, phase: entry.phase }).toEqual({ kind: before.kind, phase: before.phase });
  });
});
