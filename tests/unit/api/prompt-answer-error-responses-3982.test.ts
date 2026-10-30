/**
 * Issue #3982: both answering routes answer every error `prompt-answer-errors`
 * defines from one table, with `reason` and `keysSent` in the body.
 *
 * Before: `/prompt-response` answered `PromptAnswerInputLostError` as a bare
 * 500 (`{ error }` only) — the reason was findable only in the message text —
 * and `/respond` gave it `reason` but no `keysSent`.
 *
 * Positive controls: InputLost is 500 + `reason: answer_input_lost` +
 * `keysSent: true` on both routes; every exported error class has a row, and
 * the check that says so flags a class without one. Negative controls: the
 * refusals keep their status and their existing keys (`/prompt-response` 200
 * `success: false`, `/respond` 409 for `answer_not_delivered`), and an error
 * the table does not define keeps the plain 500.
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
vi.mock('@/lib/prompt-answer-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prompt-answer-sender')>()),
  sendPromptAnswer: vi.fn().mockResolvedValue(undefined),
}));
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

import * as promptAnswerErrors from '@/lib/prompt-answer-errors';
import {
  ANSWER_INPUT_LOST_REASON,
  FreeTextAnswerRejectedError,
  FreeTextAtChoiceOnlyPromptError,
  MultiSelectAnswerRejectedError,
  PROMPT_ANSWER_ERROR_RESPONSES,
  PromptAnswerAbortedError,
  PromptAnswerInputLostError,
  PromptAnswerNotDeliveredError,
  PromptAnswerRejectedError,
  promptAnswerErrorResponse,
} from '@/lib/prompt-answer-errors';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import type { DialogVerdict } from '@/lib/detection/tools/types';
import { POST as respond } from '@/app/api/worktrees/[id]/respond/route';
import { sendResolvedAnswer } from '@/app/api/worktrees/[id]/prompt-response/answer-delivery';
import type { PromptResponseContext } from '@/app/api/worktrees/[id]/prompt-response/context';
import type { ValidatedPromptResponse } from '@/app/api/worktrees/[id]/prompt-response/request-validation';
import type { ResolvedAnswer } from '@/app/api/worktrees/[id]/prompt-response/answer-resolution';
import { noteManualAnswerStarted } from '@/lib/polling/auto-yes-manual-answer';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import type { ChatMessage, PromptData, Worktree } from '@/types/models';

const WT = 'wt-3982-errors';

/** One instance of every error class the module exports, by class name. */
const SAMPLES: Record<string, () => Error> = {
  PromptAnswerRejectedError: () =>
    new PromptAnswerRejectedError('claude', '1', { kind: 'permission', options: [], answerMode: 'keys' } as DialogVerdict),
  FreeTextAnswerRejectedError: () => new FreeTextAnswerRejectedError('claude', [3]),
  FreeTextAtChoiceOnlyPromptError: () => new FreeTextAtChoiceOnlyPromptError('claude', 4),
  MultiSelectAnswerRejectedError: () => new MultiSelectAnswerRejectedError('toggle-mismatch', true, [1, 2]),
  PromptAnswerNotDeliveredError: () => new PromptAnswerNotDeliveredError('target-changed', 'cm-s'),
  PromptAnswerInputLostError: () => new PromptAnswerInputLostError('cm-s'),
  PromptAnswerAbortedError: () => new PromptAnswerAbortedError(true),
};

/** The exported values of `moduleExports` that are Error classes and have no row in `table`. */
function unmappedErrorClasses(moduleExports: Record<string, unknown>, table: ReadonlyMap<unknown, unknown>): string[] {
  return Object.entries(moduleExports)
    .filter(([, value]) => typeof value === 'function' && (value as { prototype?: unknown }).prototype instanceof Error)
    .filter(([, value]) => !table.has(value))
    .map(([name]) => name);
}

function exportedErrorClassNames(): string[] {
  return Object.entries(promptAnswerErrors)
    .filter(([, value]) => typeof value === 'function' && (value as { prototype?: unknown }).prototype instanceof Error)
    .map(([name]) => name)
    .sort();
}

// ---------------------------------------------------------------- the routes

let db: Database.Database;

const PROCEED: PromptData = {
  type: 'yes_no',
  question: 'Do you want to proceed?',
  options: ['yes', 'no'],
  status: 'pending',
};

async function postRespond(): Promise<{ status: number; body: Record<string, unknown> }> {
  const message = createMessage(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    role: 'assistant',
    content: PROCEED.question,
    messageType: 'prompt',
    promptData: PROCEED,
    timestamp: new Date(),
  } as unknown as ChatMessage);
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId: message.id, answer: 'yes' }),
  }) as unknown as NextRequest;
  const response = (await respond(request, { params: Promise.resolve({ id: WT }) })) as unknown as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const ctx = (): PromptResponseContext => ({ id: WT, db, cliToolId: 'claude', instanceId: undefined });

const validated: ValidatedPromptResponse = {
  answer: '1',
  useDefault: false,
  cliToolParam: 'claude',
  instanceId: undefined,
  bodyPromptType: undefined,
  bodyDefaultOptionNumber: undefined,
  validSubmitMode: undefined,
  planReviewAction: undefined,
  selectionNumbers: null,
  deferredSelectionError: null,
  origin: undefined,
};

/** `/prompt-response`'s send stage, as `route.ts` runs it. */
async function postPromptResponse(): Promise<{ status: number; body: Record<string, unknown> }> {
  const resolved = { resolution: { input: '1' }, effectivePromptData: undefined } as unknown as ResolvedAnswer;
  const response = await sendResolvedAnswer(
    ctx(),
    validated,
    `cm-${WT}-claude`,
    resolved,
    null,
    noteManualAnswerStarted(`${WT}:claude`),
  );
  if (response === null) throw new Error('the send was not expected to go through');
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  const worktree: Worktree = {
    id: WT,
    name: 'errors 3982',
    path: '/path/to/test',
    repositoryPath: '/path/to/repo',
    repositoryName: 'TestRepo',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);
});

describe('[#3982] the error → response table', () => {
  it('positive (coverage): every Error class prompt-answer-errors exports has a row', () => {
    expect(unmappedErrorClasses(promptAnswerErrors, PROMPT_ANSWER_ERROR_RESPONSES)).toEqual([]);
  });

  it('positive (the check above bites): a class added without a row is reported', () => {
    class PromptAnswerSomethingNewError extends Error {}
    const extended = { ...promptAnswerErrors, PromptAnswerSomethingNewError };
    expect(unmappedErrorClasses(extended, PROMPT_ANSWER_ERROR_RESPONSES)).toEqual(['PromptAnswerSomethingNewError']);
  });

  it('every exported class has a sample here, so the route tests below see each one', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(exportedErrorClassNames());
  });

  it('negative: an error the module does not define is not mapped (the route keeps its own 500)', () => {
    expect(promptAnswerErrorResponse(new Error('tmux went away'), 'prompt-response')).toBeNull();
    expect(promptAnswerErrorResponse(new Error('tmux went away'), 'respond')).toBeNull();
    expect(promptAnswerErrorResponse('not an error', 'respond')).toBeNull();
  });
});

describe('[#3982] /prompt-response and /respond answer each error the same way', () => {
  it('positive: /prompt-response answers InputLost 500 with reason and keysSent: true', async () => {
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new PromptAnswerInputLostError(`cm-${WT}-claude`));
    const { status, body } = await postPromptResponse();
    expect(status).toBe(500);
    expect(body).toMatchObject({ reason: ANSWER_INPUT_LOST_REASON, keysSent: true });
    // An older CLI reads the reason out of the text: still there.
    expect(String(body.error)).toContain('Failed to send answer to tmux:');
    expect(String(body.error)).toContain(ANSWER_INPUT_LOST_REASON);
  });

  it('positive: /respond answers InputLost 500 with reason and keysSent: true', async () => {
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new PromptAnswerInputLostError(`cm-${WT}-claude`));
    const { status, body } = await postRespond();
    expect(status).toBe(500);
    expect(body).toMatchObject({ reason: ANSWER_INPUT_LOST_REASON, keysSent: true });
    expect(String(body.error)).toContain('Failed to send answer to tmux:');
  });

  it.each(Object.keys(SAMPLES))('%s: the same reason and keysSent on both routes', async (name) => {
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(SAMPLES[name]());
    const viaPromptResponse = await postPromptResponse();
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(SAMPLES[name]());
    const viaRespond = await postRespond();

    expect(typeof viaPromptResponse.body.reason).toBe('string');
    expect(typeof viaPromptResponse.body.keysSent).toBe('boolean');
    expect(viaRespond.body.reason).toBe(viaPromptResponse.body.reason);
    expect(viaRespond.body.keysSent).toBe(viaPromptResponse.body.keysSent);
  });

  it('negative: the refusals keep their status and their existing keys', async () => {
    const statuses: Record<string, [number, number]> = {
      PromptAnswerRejectedError: [200, 500],
      FreeTextAnswerRejectedError: [200, 500],
      FreeTextAtChoiceOnlyPromptError: [200, 500],
      MultiSelectAnswerRejectedError: [200, 500],
      PromptAnswerNotDeliveredError: [200, 409],
      PromptAnswerInputLostError: [500, 500],
      PromptAnswerAbortedError: [500, 500],
    };
    for (const [name, [promptResponseStatus, respondStatus]] of Object.entries(statuses)) {
      const error = SAMPLES[name]();
      vi.mocked(sendPromptAnswer).mockRejectedValueOnce(error);
      const viaPromptResponse = await postPromptResponse();
      vi.mocked(sendPromptAnswer).mockRejectedValueOnce(SAMPLES[name]());
      const viaRespond = await postRespond();

      expect([name, viaPromptResponse.status]).toEqual([name, promptResponseStatus]);
      expect([name, viaRespond.status]).toEqual([name, respondStatus]);
      if (promptResponseStatus === 200) {
        expect(viaPromptResponse.body).toMatchObject({ success: false, message: error.message, answer: '1' });
      }
      if (respondStatus === 409) {
        expect(viaRespond.body).toMatchObject({ error: error.message, reason: 'answer_not_delivered' });
      }
    }
  });

  it('negative: unresolvable_answer and answer_not_delivered keep their reason codes', async () => {
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(SAMPLES.FreeTextAtChoiceOnlyPromptError());
    expect((await postPromptResponse()).body).toMatchObject({ success: false, reason: 'unresolvable_answer' });
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(SAMPLES.PromptAnswerNotDeliveredError());
    expect((await postPromptResponse()).body).toMatchObject({ success: false, reason: 'answer_not_delivered' });
  });

  it('negative: any other error stays the plain 500, with no reason', async () => {
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new Error('tmux went away: answer_input_lost quoted'));
    const viaPromptResponse = await postPromptResponse();
    vi.mocked(sendPromptAnswer).mockRejectedValueOnce(new Error('tmux went away: answer_input_lost quoted'));
    const viaRespond = await postRespond();
    for (const { status, body } of [viaPromptResponse, viaRespond]) {
      expect(status).toBe(500);
      expect(body).toEqual({ error: 'Failed to send answer to tmux: tmux went away: answer_input_lost quoted' });
    }
  });
});
