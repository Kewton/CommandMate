/**
 * `POST /send` refuses a dialog only the agent's hooks can see (Issue #1737).
 *
 * The unit tests pin the composition. What is only visible here is that the
 * pieces are connected: the *real* `Notification(permission_prompt)` payload —
 * the file captured off a live v2.1.223 session in #1721 — posted the way an
 * injected `type: "http"` hook posts it, reaches `agent-event-state`, and the
 * send route then answers 409 for a frame the terminal scraper reads as
 * perfectly ordinary. Before this Issue the same state produced
 * `isPromptWaiting: true` in the payload and a 201 from the send: two answers to
 * one question, and the send was the wrong one.
 *
 * Every refusal here is paired with the payload built from the same state, which
 * is the invariant this Issue is really about — not "the guard fires" but "the
 * guard and the payload cannot disagree".
 *
 * And every refusal is paired with a way out, because the failure this design
 * had to avoid is not a missed guard: it is a session nobody can send to.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages } from '@/lib/db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/session/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(true)),
  sendMessageToClaude: vi.fn(),
  isClaudeInstalled: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return { ...actual, captureSessionOutput: vi.fn() };
});

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

import { POST as agentEvent } from '@/app/api/hooks/agent-event/route';
import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { sendMessageToClaude } from '@/lib/session/claude-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';
import {
  STRUCTURED_SEND_BLOCK_MAX_AGE_MS,
  STRUCTURED_SEND_GUARD_ENV,
} from '@/lib/session/prompt-waiting-composition';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';

const WORKTREE_ID = 'wt-1737';
const INSTANCE_ID = 'claude';
const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

/** The frame that made #1708 possible: interactive, and unreadable. */
const UNREADABLE_FRAME = 'writing files\nediting src/app/page.tsx\n';

let db: Database.Database;

/** Post a captured hook payload exactly as an injected `type: "http"` hook does. */
async function postFixture(name: string): Promise<void> {
  const payload = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>;
  const request = new Request(
    `http://127.0.0.1:3000/api/hooks/agent-event` +
      `?tool=claude&worktreeId=${WORKTREE_ID}&instanceId=${INSTANCE_ID}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, cwd: undefined }),
    },
  );
  const response = await agentEvent(request as unknown as import('next/server').NextRequest);
  expect(response.status).toBe(202);
}

function post(body: unknown) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as import('next/server').NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
    setMockDb: (d: Database.Database) => void;
  };
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'issue-1737',
    path: '/path/to/wt-1737',
    repositoryPath: '/path/to/repo',
    repositoryName: 'CommandMate',
    cliToolId: 'claude',
  };
  upsertWorktree(db, worktree);

  vi.clearAllMocks();
  clearAgentStopEvents();
  delete process.env[STRUCTURED_SEND_GUARD_ENV];
  vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
});

afterEach(async () => {
  delete process.env[STRUCTURED_SEND_GUARD_ENV];
  clearAgentStopEvents();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
});

describe('the hook-reported dialog now stops the send (Issue #1737)', () => {
  it('answers 409 PROMPT_WAITING for a frame the scraper reads as busy', async () => {
    // The control first: the very same frame, before the event, is sendable.
    // Without it, "409" would prove nothing about the event.
    const before = await post({ content: 'nudge: are you still working?' });
    expect(before.status).toBe(201);
    vi.mocked(sendMessageToClaude).mockClear();

    await postFixture('notification-permission-prompt.json');

    const response = await post({ content: 'nudge: are you still working?' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe(PROMPT_WAITING_CODE);
    expect(sendMessageToClaude).not.toHaveBeenCalled();
    // Nothing was typed, so nothing may be recorded as if it had been.
    expect(getMessages(db, WORKTREE_ID, { limit: 10 })).toHaveLength(1);
  });

  it('agrees with the payload built from the same state', async () => {
    // The defect: `buildCurrentOutput` said waiting, the guard said send away.
    await postFixture('notification-permission-prompt.json');

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    const response = await post({ content: 'nudge' });

    expect(payload.isPromptWaiting).toBe(true);
    expect(response.status).toBe(409);
  });

  it('names a way out an operator can act on', async () => {
    await postFixture('notification-permission-prompt.json');

    const body = await (await post({ content: 'nudge' })).json();

    // `respond` is the answer when the dialog is real…
    expect(body.error).toContain(`commandmate respond ${WORKTREE_ID}`);
    // …and this is the answer when the pane looks idle and it is not.
    expect(body.error).toContain('--ignore-structured-prompt');
  });

  it('lets the send through again after the agent posts its Stop', async () => {
    await postFixture('notification-permission-prompt.json');
    expect((await post({ content: 'nudge' })).status).toBe(409);

    await postFixture('stop.json');

    expect((await post({ content: 'go ahead' })).status).toBe(201);
    expect(sendMessageToClaude).toHaveBeenCalledWith(WORKTREE_ID, 'go ahead', undefined);
  });

  it('does not refuse for an instance that reported nothing', async () => {
    await postFixture('notification-permission-prompt.json');

    const response = await post({ content: 'go ahead', instanceId: 'claude-2' });

    expect(response.status).toBe(201);
  });
});

describe('the session never becomes unwritable (Issue #1737)', () => {
  it('sends again once the record outlives the send-block bound', async () => {
    // No release event ever arrives — hooks are fail-open, so this is a state
    // the server has to survive rather than one it can rule out. The record is
    // still published as a prompt; it has simply stopped vetoing sends.
    recordAgentEvent(WORKTREE_ID, 'claude', INSTANCE_ID, {
      event: 'notification',
      at: Date.now() - STRUCTURED_SEND_BLOCK_MAX_AGE_MS - 1_000,
      detail: 'permission_prompt',
      sessionId: 'sess-1737',
      message: 'Claude needs your permission to use Bash',
    });

    const payload = await buildCurrentOutput(db, WORKTREE_ID, 'claude', INSTANCE_ID);
    const response = await post({ content: 'still there?' });

    expect(payload.isPromptWaiting).toBe(true);
    expect(response.status).toBe(201);
  });

  it('sends immediately with --ignore-structured-prompt', async () => {
    await postFixture('notification-permission-prompt.json');
    expect((await post({ content: 'nudge' })).status).toBe(409);

    const response = await post({ content: 'nudge', ignoreStructuredPromptGuard: true });

    expect(response.status).toBe(201);
    expect(sendMessageToClaude).toHaveBeenCalledWith(WORKTREE_ID, 'nudge', undefined);
  });

  it('sends with the server-wide switch off', async () => {
    await postFixture('notification-permission-prompt.json');
    process.env[STRUCTURED_SEND_GUARD_ENV] = 'off';

    expect((await post({ content: 'nudge' })).status).toBe(201);
  });
});

describe('what the escape hatches must not do (Issue #1737)', () => {
  /** A live Claude frame with an unanswered permission dialog on it. */
  const PROMPT_FRAME = readFileSync(
    join(process.cwd(), 'tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
    'utf8',
  );

  it('keeps refusing a dialog the scraper can see', async () => {
    // Bypassing that one is the #1708 damage itself: the text lands in the
    // dialog's input line and the next `respond` answers with it.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    process.env[STRUCTURED_SEND_GUARD_ENV] = 'off';

    const response = await post({ content: 'nudge', ignoreStructuredPromptGuard: true });

    expect(response.status).toBe(409);
    expect(sendMessageToClaude).not.toHaveBeenCalled();
  });

  it('is opt-in: an ordinary body still gets the guard', async () => {
    await postFixture('notification-permission-prompt.json');

    // Anything other than an explicit `true` leaves the guard in place, so a
    // client that sends the field by accident cannot disable it.
    expect((await post({ content: 'nudge', ignoreStructuredPromptGuard: 'yes' })).status).toBe(409);
    expect((await post({ content: 'nudge' })).status).toBe(409);
  });
});
