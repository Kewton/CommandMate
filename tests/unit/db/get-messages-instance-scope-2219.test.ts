/**
 * `getMessages({ matchResolvedInstance: true })` — the scope the #379 orphan
 * cleanup needed and did not have (Issue #2219).
 *
 * `getMessages` filters on the instance *or* the tool (#868's `if/else`), which
 * is right for the read paths that ask for one or the other, and wrong for a
 * caller that has an instance id which may be implicit. `sendUserMessage`'s
 * duplicate guard is exactly that caller: an omitted `instanceId` meant "the
 * primary instance" everywhere else in the flow and meant "every instance of
 * this tool" here, so a re-send from `claude` could delete `claude-2`'s newest
 * user row.
 *
 * Fixing it with a bare `instance_id = ?` would have swapped one silent bug for
 * another: rows written before #868 carry `instance_id IS NULL`, `mapChatMessage`
 * reads them back as the primary instance, and the UI shows them — so the guard
 * would stop seeing the very row it exists to de-duplicate. This option matches
 * on `COALESCE(instance_id, cli_tool_id, 'claude')`, the same expression
 * `findUnkeyedUserMessages` settled on for the same reason (#2196).
 *
 * Everything here runs against a real SQLite database, because the claim being
 * made is about SQL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-2219-scope';

describe('getMessages instance scope (Issue #2219)', () => {
  let db: Database.Database;
  let clock = 1700000000000;

  /** Insert one row, newer than every row inserted before it. */
  const add = (
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

  /**
   * Rewrite a row to the pre-#868 shape.
   *
   * `createMessage` has defaulted `instance_id` to the tool id since #868, so
   * the only way to get a legacy row is to produce one — and legacy rows are
   * half of what this option exists for.
   */
  const makeLegacy = (id: string) => {
    db.prepare('UPDATE chat_messages SET instance_id = NULL WHERE id = ?').run(id);
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    clock = 1700000000000;
    const worktree: Worktree = {
      id: WT,
      name: 'Scope Worktree',
      path: '/test/scope-2219',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  it('does not return a sibling instance as the primary instance newest row', () => {
    add('primary text');
    add('alias text', { instanceId: 'claude-2' });

    // Unscoped, the newest row in the worktree is the alias one — which is what
    // the orphan search used to get handed.
    expect(getMessages(db, WT, { limit: 1, cliToolId: 'claude' })[0].content).toBe('alias text');

    const scoped = getMessages(db, WT, {
      limit: 1,
      cliToolId: 'claude',
      instanceId: 'claude',
      matchResolvedInstance: true,
    });
    expect(scoped.map((m) => m.content)).toEqual(['primary text']);
  });

  it('returns a pre-#868 NULL-instance row as the primary instance row', () => {
    const legacy = add('legacy text');
    makeLegacy(legacy.id);

    const scoped = getMessages(db, WT, {
      limit: 1,
      cliToolId: 'claude',
      instanceId: 'claude',
      matchResolvedInstance: true,
    });
    expect(scoped.map((m) => m.content)).toEqual(['legacy text']);
    // And it reads back as the primary instance, which is why it has to match.
    expect(scoped[0].instanceId).toBe('claude');

    // The naive fix would have lost it.
    const bare = getMessages(db, WT, { limit: 1, instanceId: 'claude' });
    expect(bare).toHaveLength(0);
  });

  it('scopes an alias instance to its own rows', () => {
    add('primary text');
    add('alias text', { instanceId: 'claude-2' });

    const scoped = getMessages(db, WT, {
      limit: 50,
      cliToolId: 'claude',
      instanceId: 'claude-2',
      matchResolvedInstance: true,
    });
    expect(scoped.map((m) => m.content)).toEqual(['alias text']);
  });

  it('keeps the tool filter, so another tool cannot answer for this instance', () => {
    // A resolved instance id is only unique inside its tool. Matching the
    // instance column alone would let a codex row whose instance happened to be
    // named `claude` land in the claude pane's scope.
    const stray = add('codex row', { cliToolId: 'codex', instanceId: 'codex' });
    db.prepare('UPDATE chat_messages SET instance_id = ? WHERE id = ?').run('claude', stray.id);

    const scoped = getMessages(db, WT, {
      limit: 50,
      cliToolId: 'claude',
      instanceId: 'claude',
      matchResolvedInstance: true,
    });
    expect(scoped).toHaveLength(0);
  });

  it('still honours the archived filter', () => {
    const row = add('archived text');
    db.prepare('UPDATE chat_messages SET archived = 1 WHERE id = ?').run(row.id);

    expect(
      getMessages(db, WT, {
        limit: 50,
        cliToolId: 'claude',
        instanceId: 'claude',
        matchResolvedInstance: true,
      }),
    ).toHaveLength(0);
    expect(
      getMessages(db, WT, {
        limit: 50,
        cliToolId: 'claude',
        instanceId: 'claude',
        matchResolvedInstance: true,
        includeArchived: true,
      }),
    ).toHaveLength(1);
  });

  it('leaves every existing caller alone (the option is opt-in)', () => {
    const legacy = add('legacy text');
    makeLegacy(legacy.id);
    add('alias text', { instanceId: 'claude-2' });

    // #868 behaviour, unchanged: the instance filter reads the raw column and
    // the tool filter returns every instance of the tool.
    expect(getMessages(db, WT, { limit: 50, instanceId: 'claude' })).toHaveLength(0);
    expect(getMessages(db, WT, { limit: 50, instanceId: 'claude-2' }).map((m) => m.content)).toEqual([
      'alias text',
    ]);
    expect(getMessages(db, WT, { limit: 50, cliToolId: 'claude' }).map((m) => m.content).sort()).toEqual(
      ['alias text', 'legacy text'],
    );
  });

  it('applies the same scope to pair-unit paging', () => {
    // `limitUnit: 'pairs'` resolves its cutoff from a second query built by the
    // same `buildScope`, so a scope that applied to only one of the two would
    // return another instance's rows around a correctly-scoped cutoff.
    add('primary turn');
    add('primary reply', { role: 'assistant' });
    add('alias turn', { instanceId: 'claude-2' });
    add('alias reply', { role: 'assistant', instanceId: 'claude-2' });

    const scoped = getMessages(db, WT, {
      limit: 5,
      cliToolId: 'claude',
      instanceId: 'claude',
      matchResolvedInstance: true,
      limitUnit: 'pairs',
    });
    expect(scoped.map((m) => m.content).sort()).toEqual(['primary reply', 'primary turn']);
  });
});
