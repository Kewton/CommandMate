/**
 * resolveInstanceCliTool() tests (Issue #1629).
 *
 * Pins the resolution order that every instance-targeting API route shares:
 *   roster entry > explicit request > instance-id-as-primary-anchor > no signal
 * plus the conflict case, where an explicit request contradicts the roster.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances, resolveInstanceCliTool } from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';

const WORKTREE_ID = 'wt-resolve';

describe('resolveInstanceCliTool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Resolve',
      path: '/path/to/wt',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  function seedRoster() {
    setAgentInstances(db, WORKTREE_ID, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'gemini-2', cliTool: 'gemini', alias: 'Gemini 2', order: 1 },
    ]);
  }

  it('returns no signal when no instance is targeted', () => {
    expect(resolveInstanceCliTool(db, WORKTREE_ID, undefined)).toEqual({
      ok: true,
      cliToolId: null,
    });
  });

  it('passes an explicit tool through when no instance is targeted', () => {
    expect(resolveInstanceCliTool(db, WORKTREE_ID, undefined, 'codex')).toEqual({
      ok: true,
      cliToolId: 'codex',
    });
  });

  it('resolves a registered instance to its roster CLI tool', () => {
    seedRoster();
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'gemini-2')).toEqual({
      ok: true,
      cliToolId: 'gemini',
    });
  });

  it('accepts an explicit tool that agrees with the roster', () => {
    seedRoster();
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'codex', 'codex')).toEqual({
      ok: true,
      cliToolId: 'codex',
    });
  });

  it('reports a conflict when the explicit tool contradicts the roster', () => {
    seedRoster();
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'codex', 'claude')).toEqual({
      ok: false,
      instanceId: 'codex',
      rosterCliTool: 'codex',
      requestedCliTool: 'claude',
    });
  });

  it('honors the explicit tool for an instance the roster does not know', () => {
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'codex-7', 'codex')).toEqual({
      ok: true,
      cliToolId: 'codex',
    });
  });

  it('treats an unregistered instance id that names a CLI tool as that tool', () => {
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'codex')).toEqual({
      ok: true,
      cliToolId: 'codex',
    });
  });

  it('returns no signal for an unregistered ad-hoc instance id', () => {
    expect(resolveInstanceCliTool(db, WORKTREE_ID, 'codex-7')).toEqual({
      ok: true,
      cliToolId: null,
    });
  });

  it('scopes the roster lookup to the worktree', () => {
    seedRoster();
    const other: Worktree = {
      id: 'wt-other',
      name: 'Other',
      path: '/path/to/other',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    };
    upsertWorktree(db, other);

    // `gemini-2` belongs to WORKTREE_ID only, so it is unknown here and gives no
    // signal rather than leaking the other worktree's pairing.
    expect(resolveInstanceCliTool(db, 'wt-other', 'gemini-2')).toEqual({
      ok: true,
      cliToolId: null,
    });
  });
});
