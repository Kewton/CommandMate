/**
 * Issue #3881, second review N2: a person's answer is recorded with the same
 * reading as the Auto-Yes poller's audit row and the response poller's save.
 *
 * `POST /prompt-response` (the PC and phone panels and `commandmate respond`)
 * recorded the bare `effectivePromptData`. With no pending row — or one saved
 * before #3881 — the row had no reading, and the chat transcript classified it
 * from the strings: the live `lookalike-askuserquestion-200x60.txt` (an
 * AskUserQuestion that asks `Ready to submit your answers?`) became a
 * confirmation chip, and Claude's 16-column confirm page
 * (`tab-row-wrapped-16x1000.txt`) a tool approval. Now the route hands the frame
 * it verified the prompt against to the audit row, which reads it with
 * `promptDataForStorage`; sending and the pending row's own reading are as
 * before.
 *
 * Each case POSTs to the real route over the live capture (only tmux and the
 * capture call are stubbed) and reads the row back from a SQLite file under
 * `os.tmpdir()`, removed after each test.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

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
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({ kind: 'not-applicable', reason: 'no-pending-decision' }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: () => ({
        name: 'Claude',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string) => `claude-${id}`,
      }),
    })),
  },
}));

import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import { setMockDb } from '@/lib/db/db-instance';
import { extractResponse } from '@/lib/polling/response-checker';
import { promptDataForStorage } from '@/lib/polling/prompt-screen-reading';
import { toToolApprovalEntry } from '@/lib/chat/chat-tool-approvals';
import type { ChatMessage, PromptData } from '@/types/models';

const WT = 'wt-3881-manual';
const LIVE = path.resolve(__dirname, '../../fixtures/claude-confirm-live-3791');
const live = (name: string): string => readFileSync(path.join(LIVE, name), 'utf8');

const PAGE_16 = 'tab-row-wrapped-16x1000.txt';
const LOOKALIKE_QUESTION = 'lookalike-askuserquestion-200x60.txt';
const LOOKALIKE_BASH = 'lookalike-bash-approval-200x60.txt';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cmate-3881-manual-'));
  db = new Database(path.join(tmpDir, 'chat.sqlite'));
  runMigrations(db);
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt-3881-manual',
    path: path.join(tmpDir, 'wt'),
    branch: 'fix/3881',
    repositoryPath: path.join(tmpDir, 'repo'),
    repositoryName: 'repo',
    cliToolId: 'claude',
  });
});

afterEach(() => {
  setMockDb(null);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function answer(raw: string, value: string): Promise<Record<string, unknown>> {
  vi.mocked(captureSessionOutputFresh).mockResolvedValue(raw);
  const response = await promptResponse(
    new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: value }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: WT }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** The response poller's pending row for `raw`: with its reading, or (`legacy`) as saved before #3881. */
function savePending(raw: string, legacy: boolean): void {
  const detection = extractResponse(raw, 0, 'claude')?.promptDetection;
  if (!detection?.isPrompt) throw new Error('fixture drifted: no prompt');
  createMessage(db, {
    worktreeId: WT,
    role: 'assistant',
    content: detection.rawContent ?? '',
    messageType: 'prompt',
    promptData: legacy ? detection.promptData : promptDataForStorage('claude', raw, detection),
    timestamp: new Date(Date.now() - 1_000),
    cliToolId: 'claude',
    instanceId: 'claude',
  });
}

function promptRows(): ChatMessage[] {
  return getMessages(db, WT, { messageType: 'prompt' });
}

const fieldsOf = (row: ChatMessage): Record<string, unknown> => row.promptData as unknown as Record<string, unknown>;

type PendingRow = 'none' | 'with-reading' | 'pre-3881';
const PENDING: readonly PendingRow[] = ['none', 'with-reading', 'pre-3881'];

async function answerAndReload(raw: string, value: string, pending: PendingRow): Promise<ChatMessage> {
  if (pending !== 'none') savePending(raw, pending === 'pre-3881');
  expect(await answer(raw, value)).toMatchObject({ success: true });
  const rows = promptRows();
  expect(rows).toHaveLength(1);
  expect(fieldsOf(rows[0])).toMatchObject({ status: 'answered', answeredBy: 'human' });
  return rows[0];
}

describe('[#3881 N2] a person’s answer reads the same whoever wrote the row first', () => {
  it.each(PENDING)('the lookalike question (pending row: %s) is a question’s question screen', async (pending) => {
    const row = await answerAndReload(live(LOOKALIKE_QUESTION), '1', pending);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'question', classifiedFrom: 'reading' });
    expect(fieldsOf(row).reading).toMatchObject({ kind: 'question', evidence: ['question-picker-chrome'] });
  });

  it.each(PENDING)('陰性対照: the Bash approval lookalike (pending row: %s) is an approval', async (pending) => {
    const row = await answerAndReload(live(LOOKALIKE_BASH), '1', pending);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'approval', classifiedFrom: 'reading' });
  });

  it.each(PENDING)('the 16-column confirm page (pending row: %s) is a confirmation', async (pending) => {
    const row = await answerAndReload(live(PAGE_16), '1', pending);
    expect(fieldsOf(row).reading).toMatchObject({ kind: 'confirmation', evidence: ['confirm-page-reader'] });
    expect(toToolApprovalEntry(row)).toMatchObject({ phase: 'confirmation', classifiedFrom: 'reading' });
  });

  it('陽性対照: the row recorded from the bare promptData (pre-fix) is read from the strings', async () => {
    // What `recordAnswerForAudit` stored before the fix: the prompt as
    // detected, no reading — the compatibility rules then read the sentence as
    // the confirm page.
    const detection = extractResponse(live(LOOKALIKE_QUESTION), 0, 'claude')!.promptDetection!;
    const row = createMessage(db, {
      worktreeId: WT,
      role: 'assistant',
      content: '',
      messageType: 'prompt',
      promptData: { ...detection.promptData!, status: 'answered', answeredBy: 'human' } as PromptData,
      timestamp: new Date(),
      cliToolId: 'claude',
      instanceId: 'claude',
    });
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'confirmation' });
    expect(toToolApprovalEntry(row)).not.toHaveProperty('classifiedFrom');
  });

  it('the response poller’s reading is kept, not replaced, on the answer', async () => {
    savePending(live(LOOKALIKE_QUESTION), false);
    const [before] = promptRows();
    await answer(live(LOOKALIKE_QUESTION), '1');
    const [after] = promptRows();
    expect(after.id).toBe(before.id);
    expect(fieldsOf(after).reading).toEqual(fieldsOf(before).reading);
  });

  it('陰性対照: the capture failed — the answer goes out and no row is recorded, as before', async () => {
    vi.mocked(captureSessionOutputFresh).mockRejectedValueOnce(new Error('tmux capture failed'));
    const response = await promptResponse(
      new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: '1' }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ id: WT }) },
    );
    expect(response.status).toBe(200);
    expect(promptRows()).toHaveLength(0);
  });
});

describe('[#3881 N2] the verified frame’s window', () => {
  it('answer-delivery reads the frame with captureSessionOutputFresh’s default window, which the verification keeps', () => {
    const root = path.resolve(__dirname, '../../..');
    const session = readFileSync(path.join(root, 'src/lib/session/cli-session.ts'), 'utf8');
    const verification = readFileSync(
      path.join(root, 'src/app/api/worktrees/[id]/prompt-response/frame-verification.ts'),
      'utf8',
    );
    const delivery = readFileSync(
      path.join(root, 'src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts'),
      'utf8',
    );
    const fresh = /export async function captureSessionOutputFresh\([^)]*lines: number = (\d+)/s.exec(session);
    const ours = /const VERIFIED_FRAME_WINDOW_LINES = (\d+);/.exec(delivery);
    expect(fresh?.[1]).toBeDefined();
    expect(ours?.[1]).toBe(fresh?.[1]);
    expect(verification).toMatch(/captureSessionOutputFresh\(ctx\.id, ctx\.cliToolId, undefined, ctx\.instanceId\)/);
  });
});
