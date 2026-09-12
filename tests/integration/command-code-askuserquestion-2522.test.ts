/**
 * Command Code's `AskUserQuestion`, from the pane to every surface (Issue #2522).
 *
 * The units are covered elsewhere. What is only visible here is that the pieces
 * are CONNECTED: one capture goes in, and the HTTP poll, the WebSocket push,
 * `commandmate wait`, the chat-history row and `commandmate respond` all come
 * out describing the same question with the same four options and the same
 * default.
 *
 * Issue #2521 raised the defect: the pane was published as `ready` /
 * `input_prompt`, `wait` read that as a finished turn and exited 0 while the
 * agent was asking a human a question. It answered with a manual-operation
 * fallback and produced no payload; this Issue produces one. So each positive is
 * paired with the frame that still takes the fallback — without that control,
 * "the payload is there" would not say the fallback is still reachable, and a
 * question screen nobody can parse would go back to exiting 0.
 *
 * Nothing in the detection layer is stubbed. The only mocks are the transports:
 * the tmux capture in, and the keystroke out.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { mockFetchSequence, restoreFetch } from '../helpers/mock-api';
import { WaitExitCode } from '../../src/cli/types';

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb = null; },
  };
});

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Command Code',
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: (id: string, instanceId?: string) =>
          `cm-${id}-${instanceId ?? 'command-code'}`,
      }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  captureSessionOutputFresh: vi.fn(),
}));
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));

import { GET as currentOutput } from '@/app/api/worktrees/[id]/current-output/route';
import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { captureSessionOutput, captureSessionOutputFresh } from '@/lib/session/cli-session';
import { extractResponse } from '@/lib/polling/response-checker';
import type { NextRequest } from 'next/server';

const WORKTREE_ID = 'wt-2522';
const FIXTURES = join(process.cwd(), 'tests/fixtures');

/** The reported screen, derived from the live 1.53.0 capture (Issue #2521). */
const READ = readFileSync(
  join(FIXTURES, 'command-code-askuserquestion-2521/askuserquestion-wrapped-1530-200x1000.txt'),
  'utf8',
);
/** The same chrome with a gap in its numbering: the reading declines it. */
const UNREADABLE = readFileSync(
  join(FIXTURES, 'command-code-askuserquestion-2522/unsupported-missing-number.txt'),
  'utf8',
);

const QUESTION = 'Approve proceeding from the plan into worktree creation and dispatch?';

let db: Database.Database;

interface CurrentOutputPayload {
  sessionStatus?: string;
  sessionStatusReason?: string;
  isPromptWaiting?: boolean;
  isSelectionListActive?: boolean;
  promptData?: {
    type: string;
    question: string;
    options: Array<{ number: number; label: string; isDefault: boolean; requiresTextInput?: boolean }>;
    submitMode?: string;
  } | null;
  [key: string]: unknown;
}

/** The HTTP poll: `GET /api/worktrees/:id/current-output`, over one capture. */
async function pollCurrentOutput(frame: string): Promise<CurrentOutputPayload> {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  const request = new Request(
    `http://127.0.0.1:3000/api/worktrees/${WORKTREE_ID}/current-output`,
  ) as unknown as NextRequest;
  const response = await currentOutput(request, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as CurrentOutputPayload;
}

/**
 * The WebSocket push, built the way `terminal-broadcast` builds it.
 *
 * `emitTerminalSnapshot` is private and its transport is a socket, so what is
 * asserted is the thing that actually matters for parity: the push reads the
 * SAME `buildCurrentOutput` payload the poll returns, and copies these fields
 * straight through. Building it here from the real builder is what would notice
 * the two paths drifting apart.
 */
async function pushSnapshot(frame: string): Promise<Record<string, unknown>> {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  const { buildCurrentOutput } = await import('@/lib/session/current-output-builder');
  const payload = await buildCurrentOutput(db, WORKTREE_ID, 'command-code', undefined);
  return {
    sessionStatus: payload.sessionStatus,
    isPromptWaiting: payload.isPromptWaiting ?? false,
    promptData: payload.promptData ?? null,
    isSelectionListActive: payload.isSelectionListActive ?? false,
  };
}

/** Run `commandmate wait` against a payload the server just built. */
async function runWait(payload: unknown): Promise<{ exitCode: unknown; stdout: string[] }> {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mockFetchSequence([{ data: payload }]);

  const { createWaitCommand } = await import('../../src/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', WORKTREE_ID]);

  const result = {
    exitCode: exit.mock.calls[0]?.[0],
    stdout: log.mock.calls.map((c) => String(c[0])),
  };
  exit.mockRestore();
  log.mockRestore();
  error.mockRestore();
  restoreFetch();
  return result;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  (setMockDb as (d: Database.Database) => void)(db);
  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'cc-2522',
    path: '/tmp/cc-2522',
    repositoryPath: '/tmp/cc-2522-repo',
    repositoryName: 'cc-2522-repo',
    cliToolId: 'command-code',
  };
  upsertWorktree(db, worktree);
  vi.clearAllMocks();
});

afterEach(() => {
  restoreFetch();
  db.close();
});

describe('[#2522] one capture, one question, every surface', () => {
  it('the HTTP poll publishes an answerable prompt and no fallback card', async () => {
    const payload = await pollCurrentOutput(READ);

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.promptData?.question).toBe(QUESTION);
    expect(payload.promptData?.options).toHaveLength(4);
    expect(payload.promptData?.options[0].isDefault).toBe(true);
    expect(payload.promptData?.options[3].requiresTextInput).toBe(true);
    // #2521's card is arrow-only and outranks the prompt panel in
    // `resolveBlockedReason`, so both being true would draw two cards.
    expect(payload.isSelectionListActive).toBe(false);
  });

  it('the WebSocket push publishes exactly the same fields', async () => {
    const poll = await pollCurrentOutput(READ);
    const push = await pushSnapshot(READ);

    expect(push).toEqual({
      sessionStatus: poll.sessionStatus,
      isPromptWaiting: poll.isPromptWaiting,
      promptData: poll.promptData,
      isSelectionListActive: poll.isSelectionListActive,
    });
  });

  it('`wait` exits 10 with multiple_choice and the four options', async () => {
    const payload = await pollCurrentOutput(READ);
    const { exitCode, stdout } = await runWait(payload);

    expect(exitCode).toBe(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(stdout[0]) as {
      type: string;
      question: string;
      options: unknown[];
    };
    expect(output.type).toBe('multiple_choice');
    expect(output.question).toBe(QUESTION);
    expect(output.options).toHaveLength(4);
  });

  it('the response poller ends the turn on the same prompt', async () => {
    // The stored `prompt` row and the push notification's excerpt both come off
    // this reading; it is the surface #2521 left with a whole-pane body.
    const extracted = extractResponse(READ, 0, 'command-code');

    expect(extracted?.isComplete).toBe(true);
    expect(extracted?.promptDetection?.promptData?.question).toBe(QUESTION);
  });

  it('`respond` answers it and the audit row carries the same options', async () => {
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(READ);
    const request = new Request(
      `http://127.0.0.1:3000/api/worktrees/${WORKTREE_ID}/prompt-response`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: '2', cliTool: 'command-code' }),
      },
    ) as unknown as NextRequest;

    const response = await promptResponse(request, {
      params: Promise.resolve({ id: WORKTREE_ID }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    const { sendKeys } = await import('@/lib/tmux/tmux');
    // 確定仕様 D: the digit alone advances one operation.
    expect(vi.mocked(sendKeys).mock.calls).toEqual([
      [`cm-${WORKTREE_ID}-command-code`, '2', false],
    ]);

    const rows = db
      .prepare(`SELECT prompt_data FROM chat_messages WHERE worktree_id = ?`)
      .all(WORKTREE_ID) as Array<{ prompt_data: string | null }>;
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(rows[0].prompt_data ?? 'null') as {
      question: string;
      options: unknown[];
    };
    expect(stored.question).toBe(QUESTION);
    expect(stored.options).toHaveLength(4);
  });
});

describe('[#2522] the control: a question screen nobody can parse', () => {
  it('the poll publishes #2521’s fallback and nothing answerable', async () => {
    const payload = await pollCurrentOutput(UNREADABLE);

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('command_code_selection_list');
    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.promptData).toBeNull();
  });

  it('`wait` still stops on it, as a selection list', async () => {
    const payload = await pollCurrentOutput(UNREADABLE);
    const { exitCode, stdout } = await runWait(payload);

    expect(exitCode).toBe(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(stdout[0]) as { type: string; options: unknown[] };
    expect(output.type).toBe('selection_list');
    expect(output.options).toEqual([]);
  });

  it('`respond` refuses it, stores nothing and sends no key', async () => {
    vi.mocked(captureSessionOutputFresh).mockResolvedValue(UNREADABLE);
    const request = new Request(
      `http://127.0.0.1:3000/api/worktrees/${WORKTREE_ID}/prompt-response`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: '1', cliTool: 'command-code' }),
      },
    ) as unknown as NextRequest;

    const response = await promptResponse(request, {
      params: Promise.resolve({ id: WORKTREE_ID }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.reason).toBe('unsupported_dialog_layout');

    const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux/tmux');
    expect(vi.mocked(sendKeys).mock.calls).toEqual([]);
    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([]);
    expect(db.prepare(`SELECT id FROM chat_messages`).all()).toHaveLength(0);
  });

  it('the response poller stores no prompt for it either', async () => {
    expect(extractResponse(UNREADABLE, 0, 'command-code')?.promptDetection).toBeUndefined();
  });
});
