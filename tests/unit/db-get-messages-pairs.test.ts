/**
 * Unit tests for getMessages pair-unit paging (Issue #1407)
 *
 * The History pane renders conversation-pair cards, so the display limit must be
 * counted in turns (pairs), not raw rows. Otherwise agents that emit many
 * assistant rows per turn (e.g. codex prompts/intermediate outputs) collapse a
 * `limit`-row window into far fewer cards than the user selected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { groupMessagesIntoPairs } from '@/lib/conversation-grouper';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

describe('getMessages pair-unit paging (Issue #1407)', () => {
  let db: Database.Database;
  const worktreeId = 'test-worktree-pairs';

  // Monotonically increasing timestamp so ordering is deterministic.
  let clock = 0;

  const addUser = (content: string, opts: { cliToolId?: CLIToolType; instanceId?: string } = {}) =>
    createMessage(db, {
      worktreeId,
      role: 'user',
      content,
      timestamp: new Date(++clock),
      messageType: 'normal',
      cliToolId: opts.cliToolId ?? 'codex',
      instanceId: opts.instanceId ?? opts.cliToolId ?? 'codex',
    });

  const addAssistant = (content: string, opts: { cliToolId?: CLIToolType; instanceId?: string } = {}) =>
    createMessage(db, {
      worktreeId,
      role: 'assistant',
      content,
      timestamp: new Date(++clock),
      messageType: 'normal',
      cliToolId: opts.cliToolId ?? 'codex',
      instanceId: opts.instanceId ?? opts.cliToolId ?? 'codex',
    });

  /** Seed one user turn followed by `assistantCount` assistant rows (codex-like density). */
  const addTurn = (
    label: string,
    assistantCount: number,
    opts: { cliToolId?: CLIToolType; instanceId?: string } = {}
  ) => {
    addUser(`${label}-user`, opts);
    for (let i = 0; i < assistantCount; i++) {
      addAssistant(`${label}-assistant-${i}`, opts);
    }
  };

  const userPairs = (messages: ReturnType<typeof getMessages>) =>
    groupMessagesIntoPairs(messages).filter((p) => p.userMessage !== null);

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    clock = 0;

    const worktree: Worktree = {
      id: worktreeId,
      name: 'Test Worktree',
      path: '/test/path/pairs',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'codex',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  it('returns exactly `limit` conversation turns even when assistant rows dominate', () => {
    // A leading orphan assistant (no preceding user) must NOT be included by pairs mode.
    addAssistant('leading-orphan');
    addTurn('t1', 3);
    addTurn('t2', 5);
    addTurn('t3', 2);
    addTurn('t4', 6);
    addTurn('t5', 4);

    const messages = getMessages(db, worktreeId, { limit: 3, limitUnit: 'pairs' });

    const pairs = groupMessagesIntoPairs(messages);
    // Newest 3 turns (t3, t4, t5), no orphan pair.
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.userMessage !== null)).toBe(true);
    expect(pairs.map((p) => p.userMessage?.content)).toEqual([
      't3-user',
      't4-user',
      't5-user',
    ]);
    // All assistant rows for those 3 turns are present (2 + 6 + 4).
    const assistantTotal = pairs.reduce((n, p) => n + p.assistantMessages.length, 0);
    expect(assistantTotal).toBe(12);
  });

  it('demonstrates the legacy defect: message-unit collapses to far fewer cards', () => {
    addTurn('t1', 3);
    addTurn('t2', 5);
    addTurn('t3', 2);
    addTurn('t4', 6);
    addTurn('t5', 4);

    // Default (message unit): newest 3 raw rows are all from the last turn's assistants.
    const legacy = getMessages(db, worktreeId, { limit: 3 });
    expect(legacy).toHaveLength(3);
    expect(userPairs(legacy)).toHaveLength(0); // zero user-anchored cards

    // Pair unit: the same limit yields 3 real conversation cards.
    const fixed = getMessages(db, worktreeId, { limit: 3, limitUnit: 'pairs' });
    expect(userPairs(fixed)).toHaveLength(3);
  });

  it('returns all available turns when fewer than `limit` exist', () => {
    addTurn('t1', 4);
    addTurn('t2', 6);

    const messages = getMessages(db, worktreeId, { limit: 50, limitUnit: 'pairs' });
    expect(userPairs(messages)).toHaveLength(2);
  });

  it('falls back to message-unit when no user messages exist in scope', () => {
    addAssistant('orphan-1');
    addAssistant('orphan-2');
    addAssistant('orphan-3');

    const messages = getMessages(db, worktreeId, { limit: 2, limitUnit: 'pairs' });
    // No user turns → behaves like the raw-row limit (newest 2 rows).
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.content)).toEqual(['orphan-3', 'orphan-2']);
  });

  it('scopes pair counting to a single agent instance', () => {
    // codex primary and codex-2 interleaved.
    addTurn('primary-a', 3, { cliToolId: 'codex', instanceId: 'codex' });
    addTurn('inst2-a', 4, { cliToolId: 'codex', instanceId: 'codex-2' });
    addTurn('primary-b', 2, { cliToolId: 'codex', instanceId: 'codex' });
    addTurn('inst2-b', 5, { cliToolId: 'codex', instanceId: 'codex-2' });

    const messages = getMessages(db, worktreeId, {
      limit: 1,
      limitUnit: 'pairs',
      instanceId: 'codex-2',
    });

    const pairs = userPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].userMessage?.content).toBe('inst2-b-user');
    // Only codex-2 rows returned.
    expect(messages.every((m) => m.instanceId === 'codex-2')).toBe(true);
  });

  it('pages older turns via the `before` cursor', () => {
    addTurn('t1', 2);
    addTurn('t2', 2);
    addTurn('t3', 2);

    // First page: newest turn only.
    const page1 = getMessages(db, worktreeId, { limit: 1, limitUnit: 'pairs' });
    const page1Pairs = userPairs(page1);
    expect(page1Pairs).toHaveLength(1);
    expect(page1Pairs[0].userMessage?.content).toBe('t3-user');

    // Second page: turns strictly older than the oldest row of page 1.
    const oldestOnPage1 = page1.reduce((min, m) =>
      m.timestamp.getTime() < min.timestamp.getTime() ? m : min
    );
    const page2 = getMessages(db, worktreeId, {
      limit: 1,
      limitUnit: 'pairs',
      before: oldestOnPage1.timestamp,
    });
    const page2Pairs = userPairs(page2);
    expect(page2Pairs).toHaveLength(1);
    expect(page2Pairs[0].userMessage?.content).toBe('t2-user');
  });

  it('leaves message-unit (default) behavior unchanged', () => {
    addTurn('t1', 2);
    addTurn('t2', 2);

    const explicit = getMessages(db, worktreeId, { limit: 3, limitUnit: 'messages' });
    const defaulted = getMessages(db, worktreeId, { limit: 3 });
    expect(explicit.map((m) => m.content)).toEqual(defaulted.map((m) => m.content));
    expect(defaulted).toHaveLength(3);
  });
});
