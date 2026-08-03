/**
 * Issue #1621 Phase 4 / #1645: migration v54 renumbers every existing worktree
 * to its path-derived ID.
 *
 * #1644 froze the ID but left the stored rows alone, so every one of them still
 * carries `sanitize(repoName)-sanitize(branch)`. This is the single moment the
 * whole table moves, and moving a primary key is where data gets destroyed:
 *
 * - **children must follow**, including the tables that declare no foreign key
 *   (`tasks` #1548, `verification_runs` #1544) — nothing cascades for those, so
 *   a missed one leaves rows addressing an ID nothing resolves;
 * - **the staging must be two-stage**, because one worktree's new ID can be
 *   another's current ID; the pairwise path hits the collision branch of
 *   `renameWorktreeIdPreservingChildren`, which merges and *deletes* the source;
 * - **a vacated ID must not be re-minted**, because it lives on as an alias and
 *   live worktrees beat aliases — handing it to somebody else silently
 *   redirects the first worktree's bookmarks to the second.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, runMigrations, rollbackMigrations } from '@/lib/db/migrations/runner';
import { migrations as allMigrations } from '@/lib/db/migrations';
import { planWorktreeIdRenumbering } from '@/lib/db/migrations/v54-worktree-id-path-derived';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';

/**
 * Build a database at v53 — i.e. everything #1644 shipped, before the
 * renumbering — so the migration under test runs against realistic rows.
 *
 * The runner (not the `db-migrations` barrel) is used throughout because only
 * it accepts a migration subset, and applying v54 as a *separate* step is what
 * proves it acts on rows that were already there rather than on an empty table.
 */
function makeV53Database(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db, allMigrations.filter((migration) => migration.version <= 53));
  return db;
}

/** Insert a worktree row exactly as the branch-derived scheme would have. */
function insertLegacyWorktree(
  db: Database.Database,
  id: string,
  worktreePath: string,
  branch = 'develop'
): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch, cli_tool_id)
     VALUES (?, ?, ?, ?, ?, ?, 'claude')`
  ).run(id, branch, worktreePath, '/repos/anvil', 'anvil', branch);
}

function applyV54(db: Database.Database): void {
  runMigrations(db, allMigrations.filter((migration) => migration.version === 54));
}

function worktreeIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM worktrees ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id
  );
}

function aliasRows(db: Database.Database): Array<{ old_id: string; worktree_id: string }> {
  return db
    .prepare('SELECT old_id, worktree_id FROM worktree_aliases ORDER BY old_id')
    .all() as Array<{ old_id: string; worktree_id: string }>;
}

describe('migration v54: renumber worktree IDs from path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeV53Database();
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Planning rules (pure)
  // -------------------------------------------------------------------------

  describe('planWorktreeIdRenumbering', () => {
    it('derives the ID from the directory, not the branch', () => {
      const plan = planWorktreeIdRenumbering(
        [{ id: 'mycodebranchdesk-feature-1575-scenario-demo-videos', path: '/w/commandmate-issue-1575' }],
        []
      );
      expect(plan).toEqual([
        {
          oldId: 'mycodebranchdesk-feature-1575-scenario-demo-videos',
          newId: 'commandmate-issue-1575',
        },
      ]);
    });

    it('emits nothing for a row whose ID already matches its directory', () => {
      expect(planWorktreeIdRenumbering([{ id: 'anvil', path: '/w/anvil' }], [])).toEqual([]);
    });

    it('refuses to hand one worktree the ID another is vacating', () => {
      // `/w/mycodebranchdesk-main` would derive `mycodebranchdesk-main`, which
      // is the first row's outgoing ID. Taking it would make the first row's
      // bookmarks resolve to the second (live beats alias).
      const plan = planWorktreeIdRenumbering(
        [
          { id: 'mycodebranchdesk-main', path: '/w/commandmate-main' },
          { id: 'mycodebranchdesk-develop', path: '/w/mycodebranchdesk-main' },
        ],
        []
      );
      expect(plan[0]).toEqual({ oldId: 'mycodebranchdesk-main', newId: 'commandmate-main' });
      expect(plan[1].newId).not.toBe('mycodebranchdesk-main');
      expect(plan[1].newId).toMatch(/^mycodebranchdesk-main-[0-9a-f]{8}$/);
    });

    it('refuses to mint an ID that a pre-existing alias already answers', () => {
      const plan = planWorktreeIdRenumbering(
        [{ id: 'anvil-develop', path: '/w/retired-name' }],
        ['retired-name']
      );
      expect(plan[0].newId).toMatch(/^retired-name-[0-9a-f]{8}$/);
    });

    it('disambiguates two directories that share a basename', () => {
      const plan = planWorktreeIdRenumbering(
        [
          { id: 'a-main', path: '/repo-a/main' },
          { id: 'b-main', path: '/repo-b/main' },
        ],
        []
      );
      expect(plan[0].newId).toBe('main');
      expect(plan[1].newId).toMatch(/^main-[0-9a-f]{8}$/);
    });

    it('is deterministic', () => {
      const rows = [
        { id: 'a-main', path: '/repo-a/main' },
        { id: 'b-main', path: '/repo-b/main' },
      ];
      expect(planWorktreeIdRenumbering(rows, [])).toEqual(planWorktreeIdRenumbering(rows, []));
    });
  });

  // -------------------------------------------------------------------------
  // Applied behaviour
  // -------------------------------------------------------------------------

  it('is part of the current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(54);
    applyV54(db);
    const applied = db
      .prepare('SELECT name FROM schema_version WHERE version = 54')
      .get() as { name: string } | undefined;
    expect(applied?.name).toBe('renumber-worktree-ids-from-path');
  });

  it('renumbers a branch-derived ID to its directory and records the alias', () => {
    insertLegacyWorktree(db, 'mycodebranchdesk-develop', '/w/MyCodeBranchDesk');

    applyV54(db);

    expect(worktreeIds(db)).toEqual(['mycodebranchdesk']);
    expect(aliasRows(db)).toEqual([
      { old_id: 'mycodebranchdesk-develop', worktree_id: 'mycodebranchdesk' },
    ]);
    // The whole point of the alias: the old URL / `commandmate send <id>` keeps
    // answering across the move.
    expect(resolveWorktreeIdWithAlias(db, 'mycodebranchdesk-develop')).toBe('mycodebranchdesk');
  });

  it('never merges two rows when their directory names cross over', () => {
    // The pathological shape: each directory is named after the OTHER row's
    // current ID. Handing either row the ID it "wants" would (a) shadow the
    // other's alias and (b) drive `renameWorktreeIdPreservingChildren` into its
    // collision branch, which merges the source into the destination and
    // DELETES the source row. Both IDs are therefore refused and disambiguated.
    insertLegacyWorktree(db, 'alpha', '/w/beta');
    insertLegacyWorktree(db, 'beta', '/w/alpha');
    db.prepare(
      `INSERT INTO chat_messages (worktree_id, role, content, timestamp, cli_tool_id)
       VALUES (?, 'user', ?, ?, 'claude')`
    ).run('alpha', 'from alpha', Date.now());
    db.prepare(
      `INSERT INTO chat_messages (worktree_id, role, content, timestamp, cli_tool_id)
       VALUES (?, 'user', ?, ?, 'claude')`
    ).run('beta', 'from beta', Date.now());

    applyV54(db);

    // Two rows still exist — the collision branch would have left one.
    const ids = worktreeIds(db);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => /^(alpha|beta)-[0-9a-f]{8}$/.test(id))).toBe(true);

    // Each row kept its own directory and its own history.
    const rowFor = (worktreePath: string) =>
      db.prepare('SELECT id FROM worktrees WHERE path = ?').get(worktreePath) as
        | { id: string }
        | undefined;
    const messageFor = (id: string) =>
      (db.prepare('SELECT content FROM chat_messages WHERE worktree_id = ?').get(id) as
        | { content: string }
        | undefined)?.content;
    expect(messageFor(rowFor('/w/beta')!.id)).toBe('from alpha');
    expect(messageFor(rowFor('/w/alpha')!.id)).toBe('from beta');

    // Both old IDs still answer, each pointing at its own worktree.
    expect(resolveWorktreeIdWithAlias(db, 'alpha')).toBe(rowFor('/w/beta')!.id);
    expect(resolveWorktreeIdWithAlias(db, 'beta')).toBe(rowFor('/w/alpha')!.id);
  });

  it('leaves no orphan in ANY table carrying a worktree_id, FK or not', () => {
    insertLegacyWorktree(db, 'anvil-develop', '/w/anvil-workspace');
    const now = Date.now();

    // One row in each of the three tables that declare no foreign key — the
    // exact set #1621 found stranded — plus an FK-declared one as a control.
    db.prepare(
      `INSERT INTO chat_messages (worktree_id, role, content, timestamp, cli_tool_id)
       VALUES ('anvil-develop', 'user', 'hi', ?, 'claude')`
    ).run(now);
    db.prepare(
      `INSERT INTO tasks (id, worktree_id, cli_tool_id, title, goal, contract_json, status, created_at, updated_at)
       VALUES ('task-1', 'anvil-develop', 'claude', 't', 'g', '{}', 'pending', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO verification_runs (worktree_id, trigger, status, started_at)
       VALUES ('anvil-develop', 'manual', 'passed', ?)`
    ).run(now);
    db.prepare(
      `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
       VALUES ('anvil-develop', 'claude', 'claude', '', 0, ?)`
    ).run(now);

    applyV54(db);

    expect(worktreeIds(db)).toEqual(['anvil-workspace']);

    // Enumerated from the live schema, so a table added later is covered too.
    for (const { table, column } of getWorktreeChildTables(db)) {
      const orphans = db
        .prepare(
          `SELECT COUNT(*) AS n FROM "${table}"
            WHERE "${column}" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM worktrees w WHERE w.id = "${table}"."${column}")`
        )
        .get() as { n: number };
      expect({ table, orphans: orphans.n }).toEqual({ table, orphans: 0 });
    }

    // And they moved rather than being deleted.
    for (const table of ['chat_messages', 'tasks', 'verification_runs', 'agent_instances']) {
      const moved = db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE worktree_id = 'anvil-workspace'`)
        .get() as { n: number };
      expect({ table, rows: moved.n }).toEqual({ table, rows: 1 });
    }
  });

  it('keeps append-only skill_operations rows on their historical ID', () => {
    insertLegacyWorktree(db, 'anvil-develop', '/w/anvil-workspace');
    const now = Date.now();
    const columns = (
      db.prepare('PRAGMA table_info(skill_operations)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    ).filter((column) => column.notnull === 1 && column.dflt_value === null);
    const values = columns.map((column) => {
      if (column.name === 'worktree_id') return 'anvil-develop';
      if (column.name.endsWith('_at')) return now;
      return 'x';
    });
    db.prepare(
      `INSERT INTO skill_operations (${columns.map((c) => `"${c.name}"`).join(',')})
       VALUES (${columns.map(() => '?').join(',')})`
    ).run(...values);

    // The trigger aborts any UPDATE, which would roll back the whole migration.
    expect(() => applyV54(db)).not.toThrow();
    expect(worktreeIds(db)).toEqual(['anvil-workspace']);

    const ledger = db
      .prepare('SELECT worktree_id FROM skill_operations')
      .all() as Array<{ worktree_id: string }>;
    // Deliberate: an audit row records the identity in force at the time, and
    // the alias keeps it resolvable.
    expect(ledger).toEqual([{ worktree_id: 'anvil-develop' }]);
    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBe('anvil-workspace');
  });

  it('leaves no alias for the temporary staging IDs', () => {
    // Every rename is routed old -> cmate-mig54-<n> -> new, so stage 2 records
    // an alias for an ID that never left this transaction. It must not survive:
    // it would answer requests and, worse, occupy an ID forever (the minter
    // treats aliases as taken).
    insertLegacyWorktree(db, 'alpha', '/w/beta');
    insertLegacyWorktree(db, 'beta', '/w/alpha');

    applyV54(db);

    const aliases = aliasRows(db);
    expect(aliases.some((row) => row.old_id.startsWith('cmate-mig54-'))).toBe(false);
    expect(aliases.map((row) => row.old_id)).toEqual(['alpha', 'beta']);
  });

  it('is a no-op on a database whose IDs are already path-derived', () => {
    insertLegacyWorktree(db, 'anvil-workspace', '/w/anvil-workspace');

    applyV54(db);

    expect(worktreeIds(db)).toEqual(['anvil-workspace']);
    expect(aliasRows(db)).toEqual([]);
  });

  it('handles an empty worktrees table', () => {
    expect(() => applyV54(db)).not.toThrow();
    expect(worktreeIds(db)).toEqual([]);
  });

  it('restores the previous IDs on rollback', () => {
    insertLegacyWorktree(db, 'mycodebranchdesk-develop', '/w/MyCodeBranchDesk');
    applyV54(db);
    expect(worktreeIds(db)).toEqual(['mycodebranchdesk']);

    rollbackMigrations(db, allMigrations, 53);

    expect(worktreeIds(db)).toEqual(['mycodebranchdesk-develop']);
    expect(aliasRows(db)).toEqual([]);
  });
});
