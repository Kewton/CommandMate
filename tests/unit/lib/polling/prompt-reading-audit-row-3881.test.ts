/**
 * Issue #3881 review P2-2: the Auto-Yes poller's audit row carries the same
 * reading as the response poller's row, so a row's chip does not depend on
 * which of the two wrote it first.
 *
 * Before: the response poller's save stored `promptData.reading`, but when
 * Auto-Yes answered first, `recordAnsweredPrompt` CREATED the row from the
 * bare `promptData` — and the chat transcript then classified it from the
 * strings. On the live `lookalike-askuserquestion-200x60.txt` (an
 * AskUserQuestion that asks `Ready to submit your answers?`) that is a
 * confirmation chip for what is a question.
 *
 * Each case answers through the real `detectAndRespondToPrompt` and reads the
 * row back from a SQLite file under `os.tmpdir()` (removed after each test):
 * with no pending row, with the response poller's pending row (with its
 * reading), and with a pending row saved before #3881 (no reading).
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { ChatMessage, PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) =>
    sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        name: cliToolId,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? cliToolId}`,
      }),
    }),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  detectAndRespondToPrompt,
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { extractResponse } from '@/lib/polling/response-checker';
import { promptDataForStorage } from '@/lib/polling/prompt-screen-reading';
import { toToolApprovalEntry } from '@/lib/chat/chat-tool-approvals';

const WT = 'wt-3881-audit';
const LIVE = path.resolve(__dirname, '../../../fixtures/claude-confirm-live-3791');
const live = (name: string): string => readFileSync(path.join(LIVE, name), 'utf8');

const PAGE_16 = 'tab-row-wrapped-16x1000.txt';
const LOOKALIKE_QUESTION = 'lookalike-askuserquestion-200x60.txt';
const LOOKALIKE_BASH = 'lookalike-bash-approval-200x60.txt';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cmate-3881-audit-'));
  db = new Database(path.join(tmpDir, 'chat.sqlite'));
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt-3881-audit',
    path: path.join(tmpDir, 'wt'),
    branch: 'fix/3881',
    repositoryPath: path.join(tmpDir, 'repo'),
    repositoryName: 'repo',
    cliToolId: 'claude',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One poller tick on `raw`, spelled the way `capturePollerFrame` hands it over. */
function respondTo(raw: string): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, pollerState(), 'claude', clean, clean.split('\n'), 'claude', raw);
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

type PendingRow = 'none' | 'with-reading' | 'pre-3881';
const PENDING: readonly PendingRow[] = ['none', 'with-reading', 'pre-3881'];

async function answerAndReload(raw: string, pending: PendingRow): Promise<ChatMessage> {
  if (pending !== 'none') savePending(raw, pending === 'pre-3881');
  expect(await respondTo(raw)).toBe('responded');
  const rows = promptRows();
  expect(rows).toHaveLength(1);
  expect((rows[0].promptData as unknown as Record<string, unknown>).answeredBy).toBe('auto');
  return rows[0];
}

describe('[#3881 P2-2] an answered row reads the same whoever wrote it first', () => {
  it.each(PENDING)('the lookalike question (pending row: %s) is a question’s question screen', async (pending) => {
    const row = await answerAndReload(live(LOOKALIKE_QUESTION), pending);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'question', classifiedFrom: 'reading' });
    expect((row.promptData as unknown as Record<string, unknown>).reading).toMatchObject({
      kind: 'question',
      evidence: ['question-picker-chrome'],
    });
  });

  it.each(PENDING)('陰性対照: the Bash approval lookalike (pending row: %s) is an approval', async (pending) => {
    const row = await answerAndReload(live(LOOKALIKE_BASH), pending);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'approval', classifiedFrom: 'reading' });
  });

  it('陽性対照: the audit row created from the bare promptData (pre-fix) is a confirmation chip', async () => {
    // What `recordAnsweredPrompt` stored before the fix: the prompt as detected,
    // no reading — the compatibility rules then read the sentence as the page.
    const detection = extractResponse(live(LOOKALIKE_QUESTION), 0, 'claude')!.promptDetection!;
    const row = createMessage(db, {
      worktreeId: WT,
      role: 'assistant',
      content: '',
      messageType: 'prompt',
      promptData: { ...detection.promptData!, status: 'answered', answeredBy: 'auto' } as PromptData,
      timestamp: new Date(),
      cliToolId: 'claude',
      instanceId: 'claude',
    });
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'confirmation' });
  });

  it('the response poller’s reading is kept, not replaced, on the answer', async () => {
    savePending(live(LOOKALIKE_QUESTION), false);
    const [before] = promptRows();
    await respondTo(live(LOOKALIKE_QUESTION));
    const [after] = promptRows();
    expect(after.id).toBe(before.id);
    expect((after.promptData as unknown as Record<string, unknown>).reading).toEqual(
      (before.promptData as unknown as Record<string, unknown>).reading,
    );
  });

  it('the 16-column confirm page gets no answer and so no audit row', async () => {
    expect(await respondTo(live(PAGE_16))).toBe('no_answer');
    expect(promptRows()).toHaveLength(0);
  });
});
