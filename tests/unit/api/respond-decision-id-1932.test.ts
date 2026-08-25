/**
 * `/respond` answering an approval named by its own decision id (Issue #1932).
 *
 * The route was built for a stored prompt row: the browser clicked a button on
 * a message, so `messageId` said which dialog was meant. opencode has no such
 * row — the scraper publishes no `promptData` for its approval — and the only
 * handle anything has on it is the id the structured layer reports.
 *
 * Two properties carry this file, and both are the ones that go wrong quietly:
 *
 *  - **the id must belong to the scope the request already resolved to.**
 *    `lib/hooks/structured-decision-response` gets that for free by never
 *    accepting an id at all; here the caller supplies one, so the same property
 *    has to be re-established by a lookup, and a lookup can be written without
 *    the filter and still look right (it answers the approval the instance is
 *    holding — just not the one that was named). Every cross-scope case below
 *    asserts `replyOpencodePermission` was NOT called, because a 404 that
 *    delivered first is the failure this Issue exists to prevent.
 *  - **the numbers really are the verdicts.** `respond … 2` must POST `always`.
 *    The mapping is restated in the route helper (the canonical one is not
 *    exported and #1930 holds that file), so it is pinned here against the wire
 *    values the source actually sends rather than against its own source text.
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

// The route imports the keystroke sender; nothing on the decision path calls
// it, and that is asserted rather than assumed (`sendKeys` never called).
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
} from '@/lib/hooks/sources/opencode/client';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { STRUCTURED_REJECT_MESSAGE } from '@/lib/hooks/structured-decision-response';
import { MAX_DECISION_ID_LENGTH } from '@/app/api/worktrees/[id]/respond/structured-decision';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { sendKeys } from '@/lib/tmux/tmux';
import type { ChatMessage, Worktree } from '@/types/models';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/** The approval the PRIMARY instance of `wt-alpha` is holding. */
const PRIMARY_DECISION = 'per_1111111111111111111111111';
/** The approval a SECOND instance of the same worktree is holding. */
const SECOND_DECISION = 'per_2222222222222222222222222';
/** The approval a DIFFERENT worktree is holding. */
const OTHER_WORKTREE_DECISION = 'per_3333333333333333333333333';

const PRIMARY_PORT = 4242;
const SECOND_PORT = 4343;
const OTHER_WORKTREE_PORT = 4444;

/** Which approval each opencode server is holding, keyed by port. */
const HELD_BY_PORT: Readonly<Record<number, string>> = {
  [PRIMARY_PORT]: PRIMARY_DECISION,
  [SECOND_PORT]: SECOND_DECISION,
  [OTHER_WORKTREE_PORT]: OTHER_WORKTREE_DECISION,
};

function pendingPermission(id: string): Record<string, unknown> {
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

function claudeWorktree(id: string): Worktree {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    repositoryPath: '/tmp/repo',
    repositoryName: 'repo',
    cliToolId: 'claude',
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
  upsertWorktree(db, opencodeWorktree('wt-beta'));

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
  rememberOpencodePort(
    { worktreeId: 'wt-beta', cliToolId: 'opencode', instanceId: undefined },
    OTHER_WORKTREE_PORT,
    '/tmp/wt-beta',
  );

  vi.mocked(fetchOpencodePendingQuestions).mockResolvedValue([]);
  vi.mocked(replyOpencodePermission).mockResolvedValue(true);
  // Each opencode server answers with the ONE approval it is holding. This is
  // what makes "the id belongs to another instance" a real fact about the
  // world rather than a flag the route could have taken the caller's word for.
  vi.mocked(fetchOpencodePendingPermissions).mockImplementation(async (port: number) => {
    const held = HELD_BY_PORT[port];
    return held ? [pendingPermission(held)] : [];
  });
});

afterEach(() => {
  resetOpencodePortAssignments();
  db.close();
});

describe('the request shape', () => {
  it('still refuses a request naming neither a message nor a decision NOR an answer', async () => {
    // Issue #2040 gave `{ answer }` alone a meaning — the one decision this
    // instance is holding — so the request that names nothing at all is what is
    // left of the pre-#1932 refusal, and the wording is unchanged because the
    // Web UI's existing flow reads it.
    const response = await post('wt-alpha', {});
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('messageId and answer are required');
  });

  it('keeps the pre-#1932 wording for a messageId with no answer', async () => {
    // The other half of the same guarantee: #2040 widened what is ACCEPTED, and
    // a request that carried a `messageId` and no answer gets the string it
    // always got rather than the `decisionId` shape's shorter one.
    const response = await post('wt-alpha', { messageId: 'some-uuid' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('messageId and answer are required');
  });

  it('refuses a decision with no answer', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_DECISION });
    expect(response.status).toBe(400);
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('discards a malformed decisionId rather than truncating it', async () => {
    for (const decisionId of [
      'per_../../etc/passwd',
      'per with spaces',
      'per_%00',
      'x'.repeat(MAX_DECISION_ID_LENGTH + 1),
    ]) {
      const response = await post('wt-alpha', { decisionId, answer: '1' });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_decision_id');
    }
    // Nothing was looked up and nothing was delivered. A truncating validator
    // would have turned the over-long id into a prefix collision with a real
    // one, which is the failure mode the discard rule exists for.
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });
});

describe('answering the approval this instance is holding', () => {
  it('POSTs the verdict over the agent API and sends no keys', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      answer: '1',
      resolved: {
        via: 'structured-decision',
        optionNumber: 1,
        optionLabel: 'Allow once',
        decisionId: PRIMARY_DECISION,
      },
    });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      PRIMARY_PORT,
      PRIMARY_DECISION,
      'once',
      undefined,
    );
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });

  it('maps every published option number to its own wire verdict', async () => {
    await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '2' });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT, PRIMARY_DECISION, 'always', undefined,
    );

    await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '3' });
    // The reason reaches the agent verbatim; it is the only way it learns WHY.
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT, PRIMARY_DECISION, 'reject', STRUCTURED_REJECT_MESSAGE,
    );
  });

  it('accepts the label and the wire word, not only the number', async () => {
    await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: 'Allow once' });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT, PRIMARY_DECISION, 'once', undefined,
    );

    await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: 'always' });
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenLastCalledWith(
      PRIMARY_PORT, PRIMARY_DECISION, 'always', undefined,
    );
  });

  it('answers the named instance, not the worktree default', async () => {
    const response = await post('wt-alpha', {
      decisionId: SECOND_DECISION,
      answer: '1',
      instanceId: 'opencode-2',
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(replyOpencodePermission)).toHaveBeenCalledWith(
      SECOND_PORT, SECOND_DECISION, 'once', undefined,
    );
  });

  it('reports an undelivered verdict instead of claiming success', async () => {
    vi.mocked(replyOpencodePermission).mockResolvedValue(false);

    const response = await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: false,
      reason: 'decision_not_delivered',
    });
  });

  it('refuses an answer that names no verdict, before anything is sent', async () => {
    const response = await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '9' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('answer_out_of_range');
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });
});

describe('the scope rule (S6 / DR4-003)', () => {
  it('404s on another INSTANCE decision id and delivers nothing', async () => {
    // The id is real and pending — on `opencode-2`. This request resolved to
    // the primary, so as far as it is concerned the decision does not exist.
    // Drop the `candidate.id === decisionId` filter in the route helper and the
    // primary's own approval gets answered instead: 200, and a command runs.
    const response = await post('wt-alpha', { decisionId: SECOND_DECISION, answer: '1' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'decision_not_found' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('404s on another WORKTREE decision id and delivers nothing', async () => {
    const response = await post('wt-alpha', {
      decisionId: OTHER_WORKTREE_DECISION,
      answer: '1',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'decision_not_found' });
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('never widens the lookup past the instance it resolved to', async () => {
    await post('wt-alpha', { decisionId: SECOND_DECISION, answer: '1' });

    // One server was asked: the one this request resolved to. A cross-instance
    // search would have to poll the others, and polling another instance is how
    // a verdict ends up addressed to a different port (S10.3 / D3 decision 3).
    expect(vi.mocked(fetchOpencodePendingPermissions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchOpencodePendingPermissions)).toHaveBeenCalledWith(PRIMARY_PORT);
  });

  it('refuses when the named tool contradicts the roster, before any lookup', async () => {
    // The roster is the user-maintained declaration of what an instance is
    // (design S4 D5 decision 2). Guessing which of the two the operator meant
    // would resolve the id against one agent and deliver the verdict to another.
    addAgentInstance(db, 'wt-alpha', {
      id: 'opencode-2',
      cliTool: 'codex',
      alias: 'codex-2',
      order: 1,
    });

    const response = await post('wt-alpha', {
      decisionId: SECOND_DECISION,
      answer: '1',
      cliTool: 'opencode',
      instanceId: 'opencode-2',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('instance_tool_conflict');
    expect(vi.mocked(fetchOpencodePendingPermissions)).not.toHaveBeenCalled();
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('404s for a source that publishes no decision identity at all', async () => {
    upsertWorktree(db, claudeWorktree('wt-claude'));

    const response = await post('wt-claude', { decisionId: PRIMARY_DECISION, answer: '1' });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('decision_not_found');
  });

  it('404s when the worktree itself is unknown', async () => {
    const response = await post('wt-missing', { decisionId: PRIMARY_DECISION, answer: '1' });
    expect(response.status).toBe(404);
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });

  it('refuses rather than delivering when membership cannot be established', async () => {
    vi.mocked(fetchOpencodePendingPermissions).mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await post('wt-alpha', { decisionId: PRIMARY_DECISION, answer: '1' });

    // NOT a 404 — the decision may well be pending — and emphatically not a
    // delivery. `answerStructuredDecision` fails open here because it has a
    // keystroke path to fall back to; this route has none.
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('decision_source_unreachable');
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });
});

describe('the messageId path (S6b)', () => {
  function promptRow(worktreeId: string): ChatMessage {
    return createMessage(db, {
      worktreeId,
      cliToolId: 'claude',
      role: 'assistant',
      content: 'Proceed?',
      messageType: 'prompt',
      promptData: {
        type: 'yes_no',
        question: 'Proceed?',
        options: ['yes', 'no'],
        status: 'pending',
      },
      timestamp: new Date(),
    } as unknown as ChatMessage);
  }

  it('404s when the message belongs to a different worktree, and types nothing', async () => {
    const message = promptRow('wt-beta');

    const response = await post('wt-alpha', { messageId: message.id, answer: 'yes' });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Message not found');
    // The hole this closes: the route resolved the SESSION from the URL's
    // worktree, so without the check a `yes` was typed into a pane the prompt
    // never came from.
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
  });

  it('still answers a message that does belong to this worktree', async () => {
    upsertWorktree(db, claudeWorktree('wt-claude'));
    const message = promptRow('wt-claude');

    const response = await post('wt-claude', { messageId: message.id, answer: 'yes' });

    expect(response.status).toBe(200);
    expect(vi.mocked(sendKeys)).toHaveBeenCalled();
  });

  it('takes the message path when both ids are sent', async () => {
    upsertWorktree(db, claudeWorktree('wt-claude'));
    const message = promptRow('wt-claude');

    const response = await post('wt-claude', {
      messageId: message.id,
      decisionId: PRIMARY_DECISION,
      answer: 'yes',
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(sendKeys)).toHaveBeenCalled();
    expect(vi.mocked(replyOpencodePermission)).not.toHaveBeenCalled();
  });
});
