/**
 * `/respond` answering a `question.asked` named by its own id (Issue #2039).
 *
 * #1932 taught this route to answer an APPROVAL by decision id. A question was
 * left out on purpose and the reasoning was written down: it is answered with a
 * choice from a list the agent supplied, not with one of the three approval
 * verdicts. That reasoning is intact — what #2039 adds is the other mapping, so
 * `POST /question/:id/reply` gets `{"answers":[["Blue"]]}` (#1758 §5.2.4) and a
 * question stops being answerable only with arrow keys.
 *
 * Three properties carry this file:
 *
 *  - **the membership rule did not move.** The `find` widened from
 *    `kind === 'permission' && id === …` to the id alone, and the array it
 *    searches is still `listPending()` for the (worktree, tool, instance) the
 *    request already resolved to. Every cross-scope case here asserts that
 *    `replyOpencodeQuestion` was NOT called, because a 404 that delivered first
 *    is the failure #1932 exists to prevent and widening the predicate is
 *    exactly how it would come back.
 *  - **the two verdict vocabularies do not cross.** `3` at a two-option
 *    question is `answer_out_of_range`, not `Reject`; an approval still resolves
 *    `3` as `Reject`. Both are asserted in one file so a change that merged the
 *    resolvers cannot pass.
 *  - **nothing is typed at a pane.** `sendKeys` is never called on any of these
 *    paths, which is the whole point of answering over the agent's own API.
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
import { sendKeys } from '@/lib/tmux/tmux';
import type { Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/** The question the PRIMARY instance of `wt-alpha` is holding. */
const PRIMARY_QUESTION = 'que_1111111111111111111111111';
/** The question a SECOND instance of the same worktree is holding. */
const SECOND_QUESTION = 'que_2222222222222222222222222';
/** The approval the primary is holding, for the crossing tests. */
const PRIMARY_PERMISSION = 'per_1111111111111111111111111';

const PRIMARY_PORT = 4242;
const SECOND_PORT = 4343;

const QUESTION_BY_PORT: Readonly<Record<number, string>> = {
  [PRIMARY_PORT]: PRIMARY_QUESTION,
  [SECOND_PORT]: SECOND_QUESTION,
};

/** The captured `question.asked`, re-keyed. Two choices: `Red`, `Blue`. */
function pendingQuestion(id: string, overrides: Record<string, unknown> = {}) {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'question-asked.json'), 'utf8'));
  return { ...asked.properties, id, ...overrides };
}

function pendingPermission(id: string) {
  const asked = JSON.parse(readFileSync(join(FIXTURES, 'permission-asked.json'), 'utf8'));
  return { ...asked.properties, id };
}

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

  upsertWorktree(db, opencodeWorktree('wt-alpha'));

  rememberOpencodePort(
    { worktreeId: 'wt-alpha', cliToolId: 'opencode', instanceId: undefined },
    PRIMARY_PORT,
    '/tmp/wt-alpha',
  );
  rememberOpencodePort(
    { worktreeId: 'wt-alpha', cliToolId: 'opencode', instanceId: 'opencode-2' },
    SECOND_PORT,
    '/tmp/wt-alpha',
  );

  vi.mocked(replyOpencodeQuestion).mockResolvedValue(true);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  // Each opencode server answers with the ONE question it is holding, so
  // "belongs to another instance" is a fact about the world rather than a flag
  // the route could have taken the caller's word for.
  vi.mocked(fetchOpencodePendingQuestions).mockImplementation(async (port: number) => {
    const held = QUESTION_BY_PORT[port];
    return held ? [pendingQuestion(held)] : [];
  });
});

afterEach(() => {
  resetOpencodePortAssignments();
  db.close();
});

describe('answering the question this instance is holding', () => {
  it('POSTs the chosen LABEL to /question/:id/reply and sends no keys', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '2' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      resolved: {
        via: 'structured-question',
        decisionId: PRIMARY_QUESTION,
        answers: [['Blue']],
        optionNumbers: [2],
        optionLabels: ['Blue'],
        freeText: false,
      },
    });
    // The measured wire shape: one array per question, of labels (#1758 §5.2.4).
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenCalledWith(
      PRIMARY_PORT,
      PRIMARY_QUESTION,
      [['Blue']],
    );
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });

  it('accepts the label as well as the number', async () => {
    await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: 'Red' });
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      PRIMARY_QUESTION,
      [['Red']],
    );
  });

  it('sends free text as the single answer', async () => {
    const response = await post('wt-alpha', {
      decisionId: PRIMARY_QUESTION,
      answer: 'neither, use green',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved: { freeText: true } });
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenLastCalledWith(
      PRIMARY_PORT,
      PRIMARY_QUESTION,
      [['neither, use green']],
    );
  });

  it('takes several choices when the agent declared multiSelect', async () => {
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([
      pendingQuestion(PRIMARY_QUESTION, {
        questions: [
          {
            question: 'Which colours?',
            header: 'Colours',
            multiSelect: true,
            options: [{ label: 'Red' }, { label: 'Blue' }],
          },
        ],
      }),
    ]);

    await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1,2' });

    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenCalledWith(
      PRIMARY_PORT,
      PRIMARY_QUESTION,
      [['Red', 'Blue']],
    );
  });

  it('answers the named instance, not the worktree default', async () => {
    const response = await post('wt-alpha', {
      decisionId: SECOND_QUESTION,
      answer: '1',
      instanceId: 'opencode-2',
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(replyOpencodeQuestion)).toHaveBeenCalledWith(
      SECOND_PORT,
      SECOND_QUESTION,
      [['Red']],
    );
  });

  it('reports an undelivered answer instead of claiming success', async () => {
    vi.mocked(replyOpencodeQuestion).mockResolvedValue(false);

    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: false,
      reason: 'decision_not_delivered',
    });
  });

  it('releases the prompt-waiting record the question opened', async () => {
    // The half that makes `wait` return: a question blocks the session exactly
    // as an approval does (§5.3.1 — the session reads `busy` and no
    // `session.idle` arrives), so a delivered answer has to retire the record
    // that says a human is blocked. `recordQuestion` opens it anonymously via
    // `reportPermissionRequestPending`; the reply retires it.
    reportPermissionRequestPending('wt-alpha', 'opencode', undefined, 'question');
    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).not.toBeNull();

    await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1' });

    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).toBeNull();
  });

  it('leaves the record alone when the answer never reached the agent', async () => {
    vi.mocked(replyOpencodeQuestion).mockResolvedValue(false);
    reportPermissionRequestPending('wt-alpha', 'opencode', undefined, 'question');

    await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1' });

    // A refused POST leaves the picker on the pane. Releasing here would tell
    // `wait` the human is unblocked while the agent is still waiting.
    expect(getStructuredPromptWaiting('wt-alpha', 'opencode', undefined)).not.toBeNull();
  });
});

describe('the question and the approval vocabularies stay apart', () => {
  it('refuses `3` at a two-option question instead of reading it as Reject', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '3' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('answer_out_of_range');
    // The list it was judged against comes back, so a caller that guessed does
    // not need a second round trip to find the real numbers.
    expect(body.options).toEqual([
      { number: 1, label: 'Red' },
      { number: 2, label: 'Blue' },
    ]);
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
    // And emphatically not down the approval endpoint either.
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('still reads `3` as Reject when the id names an APPROVAL', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockImplementation(async (port: number) =>
      port === PRIMARY_PORT ? [pendingPermission(PRIMARY_PERMISSION)] : [],
    );

    const response = await post('wt-alpha', { decisionId: PRIMARY_PERMISSION, answer: '3' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resolved: { via: 'structured-decision', optionNumber: 3, optionLabel: 'Reject' },
    });
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });

  it('refuses a multi-question call rather than guessing the other arrays', async () => {
    vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([
      pendingQuestion(PRIMARY_QUESTION, {
        questions: [
          { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
          { question: 'Editor?', options: [{ label: 'VS Code' }] },
        ],
      }),
    ]);

    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('multi_question_unsupported');
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });

  it('refuses several choices when the question is single-select', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1,2' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('multi_select_not_offered');
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });
});

describe('the scope rule is unchanged by the widened predicate (S6 / DR4-003)', () => {
  it('404s on another INSTANCE question id and delivers nothing', async () => {
    // The id is real and pending — on `opencode-2`. Widen the lookup past the
    // instance this request resolved to and the primary's own question gets
    // answered instead: 200, and the wrong agent is told what to do.
    const response = await post('wt-alpha', { decisionId: SECOND_QUESTION, answer: '1' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'decision_not_found' });
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });

  it('404s on another WORKTREE question id and delivers nothing', async () => {
    upsertWorktree(db, opencodeWorktree('wt-beta'));
    rememberOpencodePort(
      { worktreeId: 'wt-beta', cliToolId: 'opencode', instanceId: undefined },
      4444,
      '/tmp/wt-beta',
    );
    // The primary goes on holding its OWN question, so a lookup that dropped the
    // id equality would answer that one — 200, and the wrong agent is told what
    // to do. Mocking it empty here would make this case pass for free.
    vi.mocked(fetchOpencodePendingQuestions).mockImplementation(async (port: number) => {
      if (port === 4444) return [pendingQuestion('que_3333333333333333333333333')];
      const held = QUESTION_BY_PORT[port];
      return held ? [pendingQuestion(held)] : [];
    });

    const response = await post('wt-alpha', {
      decisionId: 'que_3333333333333333333333333',
      answer: '1',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'decision_not_found' });
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });

  it('asks only the server it resolved to', async () => {
    await post('wt-alpha', { decisionId: SECOND_QUESTION, answer: '1' });

    expect(vi.mocked(fetchOpencodePendingQuestions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchOpencodePendingQuestions)).toHaveBeenCalledWith(PRIMARY_PORT);
  });

  it('refuses rather than delivering when membership cannot be established', async () => {
    vi.mocked(fetchOpencodePendingQuestions).mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await post('wt-alpha', { decisionId: PRIMARY_QUESTION, answer: '1' });

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('decision_source_unreachable');
    expect(vi.mocked(replyOpencodeQuestion)).not.toHaveBeenCalled();
  });

  it('discards a malformed question id rather than truncating it', async () => {
    const response = await post('wt-alpha', { decisionId: 'que_../../etc', answer: '1' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_decision_id');
    expect(vi.mocked(fetchOpencodePendingQuestions)).not.toHaveBeenCalled();
  });
});
