/**
 * Orphan cleanup against a real database (Issue #2219).
 *
 * The unit suites pin the two halves separately — which options
 * `sendUserMessage` asks `getMessages` for, and what that option does to the
 * SQL. This one runs the real flow over a real SQLite file so the halves have
 * to agree: only the CLI tool, the socket and the poller are stubbed.
 *
 * The defect it exists for is data loss, not a display delay. `getMessages`
 * filters on the instance *or* the tool, and an ordinary send omits
 * `instanceId` (the primary instance is implicit), so the #379 duplicate guard
 * used to be handed the newest row of **every instance of the tool** — and
 * deleted it if the text matched. Re-sending "run the tests" from `claude`
 * removed `claude-2`'s row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const sendMessage = vi.fn(async () => {});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Stub',
        sendMessage: (...args: unknown[]) => sendMessage(...(args as [])),
        getSessionName: (id: string) => `stub-${id}`,
      }),
    }),
  },
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn().mockResolvedValue({ waiting: false }),
  promptWaitingMessage: () => 'prompt waiting',
}));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...args),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';

const WT = 'wt-2219-orphan';

describe('sendUserMessage orphan cleanup over a real database (Issue #2219)', () => {
  let db: Database.Database;
  let clock = 1700000000000;

  const seed = (
    content: string,
    opts: { role?: 'user' | 'assistant'; cliToolId?: CLIToolType; instanceId?: string } = {},
  ) =>
    createMessage(db, {
      worktreeId: WT,
      role: opts.role ?? 'user',
      content,
      timestamp: new Date(++clock),
      messageType: 'normal',
      cliToolId: opts.cliToolId ?? 'claude',
      instanceId: opts.instanceId,
    });

  /** Every non-archived row for one instance, oldest first. */
  const historyOf = (instanceId: string, cliToolId: CLIToolType = 'claude') =>
    getMessages(db, WT, { limit: 50, cliToolId, instanceId, matchResolvedInstance: true })
      .map((m) => m.content)
      .reverse();

  const invalidations = () =>
    broadcastMessage.mock.calls.filter((call) => call[0] === MESSAGES_INVALIDATED_EVENT_TYPE);

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    runMigrations(db);
    clock = 1700000000000;
    const worktree: Worktree = {
      id: WT,
      name: 'Orphan Worktree',
      path: '/test/orphan-2219',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  it("leaves another instance's identical row alone", async () => {
    // `claude-2` is the newest row in the worktree and repeats the text the
    // primary instance is about to send. Before the fix this row was deleted.
    seed('older primary row');
    const sibling = seed('run the tests', { instanceId: 'claude-2' });

    const result = await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(true);
    expect(historyOf('claude-2')).toEqual(['run the tests']);
    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(sibling.id)).toBeDefined();
    expect(historyOf('claude')).toEqual(['older primary row', 'run the tests']);
    // Nothing was removed, so nothing is announced.
    expect(invalidations()).toHaveLength(0);
  });

  it('still removes the primary instance\'s own unanswered duplicate, and says so', async () => {
    const orphan = seed('run the tests');

    await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
    });

    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(orphan.id)).toBeUndefined();
    expect(historyOf('claude')).toEqual(['run the tests']);
    expect(invalidations()).toHaveLength(1);
    expect(invalidations()[0][1]).toEqual({
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude',
      reason: 'orphan_cleanup',
    });
  });

  it('removes a pre-#868 NULL-instance duplicate, which a bare instance filter would hide', async () => {
    const legacy = seed('run the tests');
    db.prepare('UPDATE chat_messages SET instance_id = NULL WHERE id = ?').run(legacy.id);

    await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
    });

    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(legacy.id)).toBeUndefined();
    expect(historyOf('claude')).toEqual(['run the tests']);
    expect(invalidations()).toHaveLength(1);
  });

  it('scopes an alias send to the alias instance, in both directions', async () => {
    const primaryRow = seed('run the tests');
    const aliasOrphan = seed('run the tests', { instanceId: 'claude-2' });

    await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });

    // The alias removed its own duplicate…
    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(aliasOrphan.id)).toBeUndefined();
    // …and the primary instance's identical row is untouched.
    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(primaryRow.id)).toBeDefined();
    expect(historyOf('claude')).toEqual(['run the tests']);
    expect(historyOf('claude-2')).toEqual(['run the tests']);
    expect(invalidations()[0][1]).toMatchObject({ instanceId: 'claude-2' });
  });

  it('keeps the row when the send fails', async () => {
    // `aaf497ca`'s intent, over the real database: the orphan is only removed
    // once the retry is persisted, so a failed send costs nothing.
    const orphan = seed('run the tests');
    sendMessage.mockRejectedValueOnce(new Error('tmux session not found'));

    const result = await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(false);
    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(orphan.id)).toBeDefined();
    expect(historyOf('claude')).toEqual(['run the tests']);
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('does not treat an answered turn as an orphan', async () => {
    // The guard only fires when the newest row in scope is still the user's, so
    // an assistant reply in between protects the earlier turn.
    const answered = seed('run the tests');
    seed('done', { role: 'assistant' });

    await sendUserMessage(db, {
      worktreeId: WT,
      content: 'run the tests',
      cliToolId: 'claude',
    });

    expect(db.prepare('SELECT id FROM chat_messages WHERE id = ?').get(answered.id)).toBeDefined();
    expect(historyOf('claude')).toEqual(['run the tests', 'done', 'run the tests']);
    expect(invalidations()).toHaveLength(0);
  });
});
