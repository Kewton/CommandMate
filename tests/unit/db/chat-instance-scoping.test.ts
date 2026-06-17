/**
 * Unit tests for instance-scoped chat messages (Issue #868).
 *
 * Two instances of the SAME CLI tool (primary `claude` + additional `claude-2`)
 * must not collide: messages are stored and retrieved per instance_id, while the
 * legacy cli_tool_id filter still returns every message for that tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createMessage,
  getMessages,
  deleteMessagesByInstance,
  upsertWorktree,
} from '@/lib/db';
import type { Worktree } from '@/types/models';

const WT = 'wt-instance-scope';

describe('instance-scoped chat messages (Issue #868)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const worktree: Worktree = {
      id: WT,
      name: 'Scope Worktree',
      path: '/test/scope',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    // Primary claude instance.
    createMessage(db, {
      worktreeId: WT, role: 'user', content: 'primary-1',
      timestamp: new Date(1700000000001), cliToolId: 'claude', messageType: 'normal',
    });
    // Additional claude instance (same tool, distinct instance_id).
    createMessage(db, {
      worktreeId: WT, role: 'user', content: 'secondary-1',
      timestamp: new Date(1700000000002), cliToolId: 'claude', instanceId: 'claude-2', messageType: 'normal',
    });
    createMessage(db, {
      worktreeId: WT, role: 'assistant', content: 'secondary-2',
      timestamp: new Date(1700000000003), cliToolId: 'claude', instanceId: 'claude-2', messageType: 'normal',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('defaults instance_id to cli_tool_id for the primary instance', () => {
    const primary = getMessages(db, WT, { limit: 50, instanceId: 'claude' });
    expect(primary.map(m => m.content)).toEqual(['primary-1']);
    expect(primary[0].instanceId).toBe('claude');
  });

  it('scopes retrieval to a specific additional instance', () => {
    const secondary = getMessages(db, WT, { limit: 50, instanceId: 'claude-2' });
    expect(secondary.map(m => m.content).sort()).toEqual(['secondary-1', 'secondary-2']);
  });

  it('returns all messages for the tool when filtering by cliToolId (no instanceId)', () => {
    const all = getMessages(db, WT, { limit: 50, cliToolId: 'claude' });
    expect(all).toHaveLength(3);
  });

  it('archives only the targeted instance via deleteMessagesByInstance', () => {
    const deleted = deleteMessagesByInstance(db, WT, 'claude-2');
    expect(deleted).toBe(2);

    expect(getMessages(db, WT, { limit: 50, instanceId: 'claude-2' })).toHaveLength(0);
    // Primary instance is untouched.
    expect(getMessages(db, WT, { limit: 50, instanceId: 'claude' })).toHaveLength(1);
  });
});
