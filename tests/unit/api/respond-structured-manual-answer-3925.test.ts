/**
 * `/respond`'s structured branch tells Auto-Yes a person is answering, as the
 * stored-message branch (#3907) and `/prompt-response` (#3821 / #3880) do
 * (Issue #3925).
 *
 * The `{ decisionId, answer }` shape (the composer's `PromptPanel`, PC and
 * mobile) and the id-less `{ answer }` shape (`commandmate respond`) delivered
 * the verdict over the agent's API without `noteManualAnswerStarted`: a tick
 * under way was not stopped and the next ones were not held off the
 * confirmation the person was answering. Each shape is run for an approval and
 * a question, checking the start, the send registered right before the call
 * and the end reported (delivered / not delivered / no receipt / thrown), and
 * that no refusal touches Auto-Yes at all.
 *
 * Runs the real route, the real structured module and the real ticket
 * functions (wrapped in spies); the opencode client, tmux and the screen
 * capture are stubbed.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/tmux/session-ownership', async (importOriginal) =>
  (await import('@tests/unit/tmux/name-only-session-ownership')).nameOnlySessionOwnership(importOriginal)
);
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

/** Every step of an answer, in the order it happened. */
const steps = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
  };
});

/** How the next delivery ends when not the real one: no receipt, or a throw. */
const delivery = vi.hoisted(() => ({ next: null as null | 'no-receipt' | Error }));
vi.mock('@/lib/hooks/sources/pending-decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/pending-decisions')>();
  return {
    ...actual,
    answerPendingDecisionWithReceipt: vi.fn(async (...args: Parameters<typeof actual.answerPendingDecisionWithReceipt>) => {
      steps.push('deliver');
      const next = delivery.next;
      delivery.next = null;
      if (next instanceof Error) throw next;
      if (next === 'no-receipt') return { body: {}, delivery: null };
      return actual.answerPendingDecisionWithReceipt(...args);
    }),
  };
});

vi.mock('@/lib/polling/auto-yes-manual-answer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-manual-answer')>();
  const traced = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    vi.fn((...args: A) => {
      steps.push(name);
      return fn(...args);
    });
  return {
    ...actual,
    noteManualAnswerStarted: traced('started', actual.noteManualAnswerStarted),
    noteManualSendStarting: traced('send-starting', actual.noteManualSendStarting),
    settleManualAnswer: traced('settle', actual.settleManualAnswer),
    abandonManualSend: traced('abandon', actual.abandonManualSend),
  };
});

/** The prompt read off the screen captured right before the delivery. */
const SCREEN_PROMPT = vi.hoisted(() => ({
  type: 'multiple_choice' as const,
  question: 'Allow bash?',
  options: [
    { number: 1, label: 'Allow once', isDefault: true },
    { number: 2, label: 'Allow always', isDefault: false },
    { number: 3, label: 'Reject', isDefault: false },
  ],
  status: 'pending' as const,
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  captureSessionOutputFresh: vi.fn(async () => {
    steps.push('capture');
    return 'structured-frame';
  }),
}));
vi.mock('@/lib/polling/auto-yes-dialog-gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return {
    ...original,
    assessPromptAnswerability: (cliToolId: Parameters<typeof original.assessPromptAnswerability>[0], frame: string) => {
      const assessed = original.assessPromptAnswerability(cliToolId, frame);
      if (frame !== 'structured-frame') return assessed;
      return { ...assessed, refusal: null, promptCheck: { isPrompt: true, promptData: SCREEN_PROMPT, cleanContent: '' } };
    },
  };
});

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
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
import {
  fetchOpencodePendingPermissions,
  fetchOpencodePendingQuestions,
  replyOpencodePermission,
  replyOpencodeQuestion,
} from '@/lib/hooks/sources/opencode/client';
import { rememberOpencodePort, resetOpencodePortAssignments } from '@/lib/hooks/sources/opencode/ports';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import {
  abandonManualSend,
  clearManualAnswers,
  getManualAnswerSeq,
  isManualAnswerHolding,
  noteManualAnswerStarted,
  noteManualSendStarting,
  settleManualAnswer,
} from '@/lib/polling/auto-yes-manual-answer';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

const PRIMARY_PORT = 4242;
const SECOND_PORT = 4343;
const PERMISSION = 'per_1111111111111111111111111';
const QUESTION = 'que_1111111111111111111111111';
/** A decision the SECOND instance holds: another owner's, from the primary's side. */
const OTHER_PERMISSION = 'per_2222222222222222222222222';

const PRIMARY_KEY = buildCompositeKey('wt-alpha', 'opencode', 'opencode');

function fixture(name: string, id: string) {
  return { ...JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')).properties, id };
}

/** What each opencode server is holding. */
let held: Record<number, { permissions: string[]; questions: string[] }>;

function opencodeWorktree(id: string): Worktree {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'opencode',
  };
}

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request('http://localhost:3000/api/worktrees/wt-alpha/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, { params: Promise.resolve({ id: 'wt-alpha' }) }) as unknown as Promise<Response>;
}

let db: Database.Database;

beforeEach(async () => {
  vi.clearAllMocks();
  steps.length = 0;
  delivery.next = null;
  clearManualAnswers();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  resetOpencodePortAssignments();
  resetPendingDecisions();
  clearAgentStopEvents();
  upsertWorktree(db, opencodeWorktree('wt-alpha'));
  rememberOpencodePort({ worktreeId: 'wt-alpha', cliToolId: 'opencode', instanceId: undefined }, PRIMARY_PORT, '/tmp/wt-alpha');
  rememberOpencodePort({ worktreeId: 'wt-alpha', cliToolId: 'opencode', instanceId: 'opencode-2' }, SECOND_PORT, '/tmp/wt-alpha');

  held = {
    [PRIMARY_PORT]: { permissions: [], questions: [] },
    [SECOND_PORT]: { permissions: [OTHER_PERMISSION], questions: [] },
  };
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  vi.mocked(replyOpencodeQuestion).mockResolvedValue(true);
  vi.mocked(fetchOpencodePendingPermissions).mockImplementation(async (port: number) =>
    (held[port]?.permissions ?? []).map((id) => fixture('permission-asked.json', id)));
  vi.mocked(fetchOpencodePendingQuestions).mockImplementation(async (port: number) =>
    (held[port]?.questions ?? []).map((id) => fixture('question-asked.json', id)));
});

afterEach(() => {
  resetOpencodePortAssignments();
  clearManualAnswers();
  db.close();
});

/** The four ways in: two shapes, two kinds. `answer` is a valid one for the kind. */
const CASES = [
  { name: 'decisionId / approval', kind: 'permission', body: { decisionId: PERMISSION, answer: '1' } },
  { name: 'decisionId / question', kind: 'question', body: { decisionId: QUESTION, answer: '2' } },
  { name: 'id-less / approval', kind: 'permission', body: { answer: '1' } },
  { name: 'id-less / question', kind: 'question', body: { answer: '2' } },
] as const;

function hold(kind: 'permission' | 'question'): void {
  if (kind === 'permission') held[PRIMARY_PORT].permissions = [PERMISSION];
  else held[PRIMARY_PORT].questions = [QUESTION];
}

function failReply(kind: 'permission' | 'question'): void {
  if (kind === 'permission') vi.mocked(replyOpencodePermission).mockResolvedValue(false);
  else vi.mocked(replyOpencodeQuestion).mockResolvedValue(false);
}

describe.each(CASES)('$name goes through the manual-answer ticket', ({ kind, body }) => {
  beforeEach(() => hold(kind));

  it('notes the start, reads the screen and registers the send before delivering, then settles answered', async () => {
    const response = await post(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(steps).toEqual(['started', 'capture', 'send-starting', 'deliver', 'settle']);
    expect(vi.mocked(noteManualAnswerStarted)).toHaveBeenCalledWith(PRIMARY_KEY);
    expect(vi.mocked(noteManualSendStarting)).toHaveBeenCalledWith(expect.anything(), SCREEN_PROMPT);
    expect(vi.mocked(settleManualAnswer)).toHaveBeenCalledWith(expect.anything(), 'answered');
    // The start is real: the poller is held off this instance's confirmations.
    expect(isManualAnswerHolding(PRIMARY_KEY)).toBe(true);
    expect(getManualAnswerSeq(PRIMARY_KEY)).toBe(1);
  });

  it('settles not-sent when the source says the verdict did not reach the agent', async () => {
    failReply(kind);

    const response = await post(body);

    expect(await response.json()).toMatchObject({ success: false, reason: 'decision_not_delivered' });
    expect(vi.mocked(settleManualAnswer)).toHaveBeenCalledWith(expect.anything(), 'not-sent');
    expect(vi.mocked(abandonManualSend)).not.toHaveBeenCalled();
  });

  it('only abandons the send when the source gives no receipt (outcome unknown)', async () => {
    delivery.next = 'no-receipt';

    const response = await post(body);

    expect(await response.json()).toMatchObject({ success: false });
    expect(steps).toEqual(['started', 'capture', 'send-starting', 'deliver', 'abandon']);
    expect(vi.mocked(settleManualAnswer)).not.toHaveBeenCalled();
  });

  it('classifies a thrown delivery as the stored-message branch does, and answers 500', async () => {
    delivery.next = Object.assign(new Error('decide blew up'), { answerDelivery: 'indeterminate' });

    const response = await post(body);

    expect(response.status).toBe(500);
    expect(vi.mocked(settleManualAnswer)).toHaveBeenCalledWith(expect.anything(), 'may-be-on-pane');
  });

  it('abandons a thrown delivery that says nothing of its outcome', async () => {
    delivery.next = new Error('decide blew up');

    const response = await post(body);

    expect(response.status).toBe(500);
    expect(steps.slice(-2)).toEqual(['deliver', 'abandon']);
    expect(vi.mocked(settleManualAnswer)).not.toHaveBeenCalled();
  });
});

describe('a refusal never notes a manual answer', () => {
  function expectUntouched(): void {
    expect(vi.mocked(noteManualAnswerStarted)).not.toHaveBeenCalled();
    expect(vi.mocked(noteManualSendStarting)).not.toHaveBeenCalled();
    expect(vi.mocked(settleManualAnswer)).not.toHaveBeenCalled();
    expect(getManualAnswerSeq(PRIMARY_KEY)).toBe(0);
    expect(isManualAnswerHolding(PRIMARY_KEY)).toBe(false);
    expect(steps).not.toContain('deliver');
  }

  it('404: the named decision is not pending', async () => {
    const response = await post({ decisionId: PERMISSION, answer: '1' });
    expect(response.status).toBe(404);
    expectUntouched();
  });

  it('404: the named decision is another instance\'s', async () => {
    const response = await post({ decisionId: OTHER_PERMISSION, answer: '1' });
    expect(response.status).toBe(404);
    expectUntouched();
  });

  it('404: the id-less shape with nothing pending', async () => {
    const response = await post({ answer: '1' });
    expect(response.status).toBe(404);
    expectUntouched();
  });

  it('409: the id-less shape with two decisions pending', async () => {
    held[PRIMARY_PORT] = { permissions: [PERMISSION], questions: [QUESTION] };
    const response = await post({ answer: '1' });
    expect(response.status).toBe(409);
    expectUntouched();
  });

  it('400: an approval answer out of range', async () => {
    hold('permission');
    const response = await post({ decisionId: PERMISSION, answer: '9' });
    expect(response.status).toBe(400);
    expectUntouched();
  });

  it('400: a question answer out of range', async () => {
    hold('question');
    const response = await post({ answer: '3' });
    expect(response.status).toBe(400);
    expectUntouched();
  });

  it('400: a malformed decision id', async () => {
    const response = await post({ decisionId: 'bad id!', answer: '1' });
    expect(response.status).toBe(400);
    expectUntouched();
  });
});
