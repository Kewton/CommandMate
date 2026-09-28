/**
 * Tests for Issue #2917: upsertWorktree preserves cli_tool_id when omitted.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktreeById } from '@/lib/db/worktree-db';
import type { Worktree } from '@/types/models';

describe('upsertWorktree preserves cli_tool_id (Issue #2917)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('preserves existing cli_tool_id (command-code) when upsertWorktree is called without cliToolId', () => {
    const initial: Worktree = {
      id: 'wt-1',
      name: 'feature-1',
      path: '/repos/test/feature-1',
      repositoryPath: '/repos/test',
      repositoryName: 'test',
      cliToolId: 'command-code',
    };
    upsertWorktree(db, initial);

    const fromDbBefore = getWorktreeById(db, 'wt-1');
    expect(fromDbBefore?.cliToolId).toBe('command-code');

    // Simulate syncWorktreesToDB passing a Worktree object without cliToolId
    const syncWorktree: Worktree = {
      id: 'wt-1',
      name: 'feature-1',
      path: '/repos/test/feature-1',
      repositoryPath: '/repos/test',
      repositoryName: 'test',
    };
    upsertWorktree(db, syncWorktree);

    // Verify through getWorktreeById
    const fromDbAfter = getWorktreeById(db, 'wt-1');
    expect(fromDbAfter?.cliToolId).toBe('command-code');

    // Verify raw DB value
    const rawRow = db.prepare('SELECT cli_tool_id FROM worktrees WHERE id = ?').get('wt-1') as {
      cli_tool_id: string | null;
    };
    expect(rawRow.cli_tool_id).toBe('command-code');
  });

  it('updates cli_tool_id when an explicit cliToolId is passed', () => {
    const initial: Worktree = {
      id: 'wt-1',
      name: 'feature-1',
      path: '/repos/test/feature-1',
      repositoryPath: '/repos/test',
      repositoryName: 'test',
      cliToolId: 'command-code',
    };
    upsertWorktree(db, initial);

    // Call upsertWorktree with explicit cliToolId: 'codex'
    const updatedWorktree: Worktree = {
      id: 'wt-1',
      name: 'feature-1',
      path: '/repos/test/feature-1',
      repositoryPath: '/repos/test',
      repositoryName: 'test',
      cliToolId: 'codex',
    };
    upsertWorktree(db, updatedWorktree);

    const fromDb = getWorktreeById(db, 'wt-1');
    expect(fromDb?.cliToolId).toBe('codex');

    const rawRow = db.prepare('SELECT cli_tool_id FROM worktrees WHERE id = ?').get('wt-1') as {
      cli_tool_id: string | null;
    };
    expect(rawRow.cli_tool_id).toBe('codex');
  });

  it('defaults to claude on read when a new worktree is inserted without cliToolId, and raw DB value is NULL', () => {
    const newWorktree: Worktree = {
      id: 'wt-new',
      name: 'new-branch',
      path: '/repos/test/new-branch',
      repositoryPath: '/repos/test',
      repositoryName: 'test',
    };
    upsertWorktree(db, newWorktree);

    // Raw DB value must be NULL
    const rawRow = db.prepare('SELECT cli_tool_id FROM worktrees WHERE id = ?').get('wt-new') as {
      cli_tool_id: string | null;
    };
    expect(rawRow.cli_tool_id).toBeNull();

    // Reader resolves NULL to 'claude' default
    const fromDb = getWorktreeById(db, 'wt-new');
    expect(fromDb?.cliToolId).toBe('claude');
  });
});
