/**
 * `/respond` answering the ONE decision an instance is holding (Issue #2040).
 *
 * `commandmate respond <worktree> 3` used to be a keystroke, and on opencode a
 * keystroke is not an answer: every dialog that tool draws is `answerMode:
 * 'keys'` (#2033), so the number was refused at the sender — and before that,
 * typed at a composer. The verdict has an endpoint (`POST
 * /permission/:id/reply`) and the question has one (`POST /question/:id/reply`);
 * what was missing was a way to reach either without first lifting an id out of
 * `capture --json`.
 *
 * Three properties carry this file, and all three are safety properties:
 *
 *  - **exactly one, or nothing happens.** Zero pending is `404
 *    decision_not_found`; two or more is `409 multiple_pending_decisions`. Both
 *    assert that neither reply endpoint was called AND that no key was sent,
 *    because "answer the oldest" is the plausible implementation this rule
 *    exists to forbid.
 *  - **the capability decides, never the tool id.** claude and codex reach this
 *    route only through the shapes they always used; the id-less shape refuses
 *    them with a code of its own (`decision_source_unaddressable`) rather than
 *    with the 404 a caller might retry through.
 *  - **the two vocabularies still do not cross.** `3` resolves to `Reject` when
 *    the sole decision is an approval and to `answer_out_of_range` when it is a
 *    two-option question — the same asymmetry #2039 pinned for the addressed
 *    path, now reached without an id.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

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
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { STRUCTURED_REJECT_MESSAGE } from '@/lib/hooks/structured-decision-response';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

const PERMISSION_A = 'per_1111111111111111111111111';
const PERMISSION_B = 'per_2222222222222222222222222';
const QUESTION_A = 'que_1111111111111111111111111';

const PRIMARY_PORT = 4242;

/** The captured `permission.asked`, re-keyed. */
function pendingPermission(id: string) {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'permission-asked.json'), 'utf8'));
  return { ...asked.properties, id };
}

/** The captured `question.asked`, re-keyed. Two choices: `Red`, `Blue`. */
function pendingQuestion(id: string, overrides: Record<string, unknown> = {}) {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'question-asked.json'), 'utf8'));
  return { ...asked.properties, id, ...overrides };
}

function worktreeFor(id: string, cliToolId: CLIToolType): Worktree {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId,
  };
}

function post(worktreeId: string, body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${worktreeId}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return respond(request, {
    params: Promise.resolve({ id: worktreeId }),
  }) as unknown as Promise<Response>;
}

/** Nothing reached the pane, by either of the two ways anything ever does. */
function expectNothingTyped(): void {
  expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
}

let db: Database.Database;

beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  resetOpencodePortAssignments();
  resetPendingDecisions();
  clearAgentStopEvents();

  upsertWorktree(db, worktreeFor('wt-alpha', 'opencode'));
  upsertWorktree(db, worktreeFor('wt-claude', 'claude'));
  upsertWorktree(db, worktreeFor('wt-codex', 'codex'));

  rememberOpencodePort(
    { worktreeId: 'wt-alpha', cliToolId: 'opencode', instanceId: undefined },
    PRIMARY_PORT,
    '/tmp/wt-alpha',
  );

  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  vi.mocked(replyOpencodeQuestion).mockResolvedValue(true);
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([]);
});

afterEach(() => {
  resetOpencodePortAssignments();
  db.close();
});

describe('the sole pending approval', () => {
  beforeEach(() => {
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission(PERMISSION_A)]);
  });

  it('POSTs `reject` for `3` and types nothing at the pane', async () => {
    const response = await post('wt-alpha', { answer: '3' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      answer: '3',
      resolved: {
        via: 'structured-decision',
        optionNumber: 3,
        optionLabel: 'Reject',
        decisionId: PERMISSION_A,
      },
    });
    // The wire word, not the number: `reject` is what `POST /permission/:id/reply`
    // takes (#1758 §5.5).
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      PRIMARY_PORT,
      PERMISSION_A,
      'reject',
      // The message reaches the agent verbatim, so a rejection says who did it.
      STRUCTURED_REJECT_MESSAGE,
    );
    expectNothingTyped();
  });

  it('POSTs `once` for `1` and `always` for `2`', async () => {
    await post('wt-alpha', { answer: '1' });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      PERMISSION_A,
      'once',
      undefined,
    );

    await post('wt-alpha', { answer: '2' });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      PERMISSION_A,
      'always',
      undefined,
    );
    expectNothingTyped();
  });

  it('releases the prompt-waiting record a delivered verdict retired', async () => {
    reportPermissionRequestPending('wt-alpha', 'opencode', undefined, 'bash');
    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).not.toBeNull();

    await post('wt-alpha', { answer: '3' });

    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).toBeNull();
  });

  it('reports an undelivered verdict instead of claiming success', async () => {
    vi.mocked(replyOpencodePermission).mockResolvedValue(false);

    const response = await post('wt-alpha', { answer: '3' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: false,
      reason: 'decision_not_delivered',
    });
  });

  it('refuses a number the three verdicts do not offer, sending nothing', async () => {
    const response = await post('wt-alpha', { answer: '9' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('answer_out_of_range');
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expectNothingTyped();
  });
});

describe('the sole pending question', () => {
  beforeEach(() => {
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([pendingQuestion(QUESTION_A)]);
  });

  it('resolves the number against the choices THIS question published', async () => {
    const response = await post('wt-alpha', { answer: '2' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      resolved: {
        via: 'structured-question',
        decisionId: QUESTION_A,
        answers: [['Blue']],
        optionNumbers: [2],
        optionLabels: ['Blue'],
        freeText: false,
      },
    });
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenCalledWith(
      PRIMARY_PORT,
      QUESTION_A,
      [['Blue']],
    );
    expectNothingTyped();
  });

  it('refuses `3` at a two-option question rather than reading it as Reject', async () => {
    // The asymmetry #2039 pinned for the addressed path, reached without an id.
    // `3` is a verdict only when the decision is an approval; here it names no
    // choice, so nothing is sent down EITHER endpoint.
    const response = await post('wt-alpha', { answer: '3' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('answer_out_of_range');
    expect(body.options).toEqual([
      { number: 1, label: 'Red' },
      { number: 2, label: 'Blue' },
    ]);
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expectNothingTyped();
  });

  it('takes a label and free text as well as a number', async () => {
    await post('wt-alpha', { answer: 'Red' });
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      QUESTION_A,
      [['Red']],
    );

    await post('wt-alpha', { answer: 'neither, use green' });
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      QUESTION_A,
      [['neither, use green']],
    );
  });
});

describe('the count rule', () => {
  it('is 404 decision_not_found when the instance is holding none', async () => {
    const response = await post('wt-alpha', { answer: '3' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'decision_not_found',
      reason: 'decision_not_found',
    });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
    // The whole point: the pre-#2040 path would have gone on to type a `3`.
    expectNothingTyped();
  });

  it('is 409 when the instance is holding two approvals, and answers NEITHER', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([
      pendingPermission(PERMISSION_A),
      pendingPermission(PERMISSION_B),
    ]);

    const response = await post('wt-alpha', { answer: '1' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('multiple_pending_decisions');
    // The ids come back so the refusal is not a dead end — they are what the
    // `{ decisionId, answer }` shape takes.
    // `toolName` is the captured approval's own `permission` kind — what the
    // dialog is about, taken from the fixture rather than restated here.
    expect(body.decisions).toEqual([
      { id: PERMISSION_A, kind: 'permission', toolName: 'external_directory' },
      { id: PERMISSION_B, kind: 'permission', toolName: 'external_directory' },
    ]);
    // Answering the oldest is the plausible implementation this Issue forbids.
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expectNothingTyped();
  });

  it('is 409 when an approval and a question are open together', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission(PERMISSION_A)]);
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([pendingQuestion(QUESTION_A)]);

    const response = await post('wt-alpha', { answer: '1' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.decisions.map((d: { kind: string }) => d.kind).sort()).toEqual([
      'permission',
      'question',
    ]);
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
    expectNothingTyped();
  });

  it('leaves the prompt-waiting record alone on both refusals', async () => {
    // A refusal is not an answer: the dialog is still on the pane, and
    // releasing here would tell `wait` the human is unblocked.
    reportPermissionRequestPending('wt-alpha', 'opencode', undefined, 'bash');

    await post('wt-alpha', { answer: '1' });
    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).not.toBeNull();

    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([
      pendingPermission(PERMISSION_A),
      pendingPermission(PERMISSION_B),
    ]);
    await post('wt-alpha', { answer: '1' });
    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).not.toBeNull();
  });

  it('refuses rather than guesses when the agent cannot be reached', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await post('wt-alpha', { answer: '1' });

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('decision_source_unreachable');
    expectNothingTyped();
  });
});

describe('sources that publish no per-decision id', () => {
  // The capability read, never a tool check. These five declare
  // `eventIdentity: null`, so there is nothing here for a number to address —
  // and their answer is a code of its OWN, because `decision_not_found` is a
  // refusal a caller must not retry through and this one means "ask the other
  // endpoint".
  it.each([
    ['wt-claude', 'claude'],
    ['wt-codex', 'codex'],
  ])('refuses the id-less shape for %s', async (worktreeId) => {
    const response = await post(worktreeId, { answer: '3' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'decision_source_unaddressable',
      reason: 'decision_source_unaddressable',
    });
    expectNothingTyped();
  });

  it('does not consult the agent at all for such a source', async () => {
    await post('wt-claude', { answer: '3' });
    // The gate is read before anything is looked up, so an unreachable agent
    // cannot turn this into a 502.
    expect(vi.mocked(fetchOpencodePendingPermissions)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchOpencodePendingQuestions)).not.toHaveBeenCalled();
  });
});
