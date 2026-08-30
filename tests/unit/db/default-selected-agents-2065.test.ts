/**
 * Issue #2065: the server-wide default agent list, end to end against a real
 * migrated schema.
 *
 * The acceptance criterion is a sentence about sync, not about a function:
 * "set the default to ['codex','claude'], and a worktree discovered by the next
 * sync shows codex then claude, with codex primary". This suite reproduces that
 * exact state — a `worktrees` row with NO `selected_agents` and NO
 * `agent_instances`, which is precisely what `upsertWorktree` leaves behind —
 * and asserts the roster the API would build from it.
 *
 * The two negative halves are asserted next to it, because they are the ones a
 * plausible implementation gets wrong: an install with no setting must be
 * unchanged, and a worktree that already has `agent_instances` must not move.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  getDefaultSelectedAgents,
  setDefaultSelectedAgents,
  clearDefaultSelectedAgents,
} from '@/lib/db/app-settings-db';
import { getWorktrees, getWorktreeById } from '@/lib/db/worktree-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';

const WT = 'wt-2065';

function seedWorktree(db: Database.Database, id: string, selectedAgents?: string[]): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, selected_agents, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    id,
    `/tmp/${id}`,
    selectedAgents ? JSON.stringify(selectedAgents) : null,
    1700000000000
  );
}

describe('default_selected_agents storage (Issue #2065)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('reads back null before anything is stored', () => {
    expect(getDefaultSelectedAgents(db)).toBeNull();
  });

  it('round-trips an ordered list', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    expect(getDefaultSelectedAgents(db)).toEqual(['codex', 'claude']);
  });

  it('overwrites rather than appends on a second save', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    setDefaultSelectedAgents(db, ['gemini', 'copilot', 'claude']);
    expect(getDefaultSelectedAgents(db)).toEqual(['gemini', 'copilot', 'claude']);
  });

  it('clears back to "unset" rather than to a stored copy of the constant', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    clearDefaultSelectedAgents(db);
    expect(getDefaultSelectedAgents(db)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'default_selected_agents'").get()
    ).toEqual({ n: 0 });
  });

  /**
   * The row is reachable by hand (`sqlite3 db.sqlite`) and by a future migration.
   * Reading it back unvalidated would push an invalid roster into every worktree
   * at once, so an unusable row must read as "unset".
   */
  it('treats a hand-broken row as unset', () => {
    for (const bad of [['claude'], ['claude', 'bogus'], ['claude', 'claude'], []]) {
      db.prepare(`
        INSERT INTO app_settings (key, value, created_at, updated_at)
        VALUES ('default_selected_agents', ?, 0, 0)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(bad));
      expect(getDefaultSelectedAgents(db)).toBeNull();
    }
  });
});

describe('the setting reaches a synced worktree (Issue #2065 acceptance)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // Exactly the state `upsertWorktree` leaves: no selected_agents column value
    // and no agent_instances rows.
    seedWorktree(db, WT);
  });

  afterEach(() => {
    db.close();
  });

  it('gives a newly discovered worktree the configured order, codex primary', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    const roster = resolveAgentInstances(db, WT, getWorktreeById(db, WT)?.selectedAgents);

    expect(roster.map((i) => i.cliTool)).toEqual(['codex', 'claude']);
    expect(roster[0].cliTool).toBe('codex');
    expect(roster[0].id).toBe('codex');
    expect(roster.map((i) => i.order)).toEqual([0, 1]);
  });

  /**
   * The resolver's own `appSettings` layer, exercised directly.
   *
   * In production every caller hands it `worktree.selectedAgents`, which
   * `parseSelectedAgents()` has already resolved — so passing that value tests
   * the DB layer twice and the resolver's layer not at all. `undefined` is the
   * input that reaches it: `PATCH /api/worktrees/[id]` passes
   * `updatedWorktree?.selectedAgents`, which is `undefined` when the row is
   * gone. Before #2065 that produced an EMPTY roster (`?? []`); now it produces
   * the configured one.
   */
  it('uses the setting when the caller has no selectedAgents to offer', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    const roster = resolveAgentInstances(db, WT, undefined);

    expect(roster.map((i) => i.cliTool)).toEqual(['codex', 'claude']);
    expect(roster[0].id).toBe('codex');
  });

  it('reports the same order through getWorktrees / getWorktreeById', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    expect(getWorktreeById(db, WT)?.selectedAgents).toEqual(['codex', 'claude']);
    expect(getWorktrees(db)[0].selectedAgents).toEqual(['codex', 'claude']);
  });

  it('is unchanged from before the Issue when nothing is stored', () => {
    expect(getWorktreeById(db, WT)?.selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(getWorktrees(db)[0].selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(resolveAgentInstances(db, WT, undefined).map((i) => i.cliTool))
      .toEqual(DEFAULT_SELECTED_AGENTS);
  });

  it('lets a worktree that chose its own agents keep them', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    seedWorktree(db, 'wt-explicit', ['gemini', 'copilot']);

    expect(getWorktreeById(db, 'wt-explicit')?.selectedAgents).toEqual(['gemini', 'copilot']);
    expect(
      resolveAgentInstances(db, 'wt-explicit', getWorktreeById(db, 'wt-explicit')?.selectedAgents)
        .map((i) => i.cliTool)
    ).toEqual(['gemini', 'copilot']);
  });

  /**
   * The third acceptance criterion. `agent_instances` is the authority once rows
   * exist — including aliases the user created — so saving a preference must be
   * invisible to every branch already open.
   */
  it('never rewrites an existing agent_instances roster', () => {
    setAgentInstances(db, WT, [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'review', order: 1 },
    ]);
    const before = resolveAgentInstances(db, WT, undefined);

    setDefaultSelectedAgents(db, ['codex', 'claude']);

    expect(resolveAgentInstances(db, WT, getWorktreeById(db, WT)?.selectedAgents))
      .toEqual(before);
  });

  /**
   * `getWorktrees` resolves the setting once and threads it down, rather than
   * per row. Asserted by counting the reads, because the cheap wrong version
   * (calling `getDefaultSelectedAgents` inside the row map) is green on every
   * value assertion above and only shows up as N point queries on a sidebar poll.
   */
  it('reads the setting once per getWorktrees call, not once per row', () => {
    setDefaultSelectedAgents(db, ['codex', 'claude']);
    for (let i = 0; i < 5; i++) seedWorktree(db, `wt-many-${i}`);

    let reads = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes('FROM app_settings')) reads++;
      return realPrepare(sql);
    };

    const rows = getWorktrees(db);
    db.prepare = realPrepare;

    expect(rows.length).toBe(6);
    expect(reads).toBe(1);
    for (const row of rows) {
      expect(row.selectedAgents).toEqual(['codex', 'claude']);
    }
  });
});
