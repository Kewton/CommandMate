/**
 * Issue #2067: "apply this agent order to the branches I already have", and the
 * one rule that makes it safe — a branch the user has touched is never rewritten.
 *
 * Run against a REAL migrated schema rather than a mocked DB module, because
 * every claim here is a claim about two columns in two tables:
 * `worktrees.selected_agents` and the presence of `agent_instances` rows. A
 * mocked `getUnchangedAgentWorktreeIds` would answer all of them by
 * construction.
 *
 * "Touched" has two independent spellings and they get their own tests on
 * purpose. `PATCH /api/worktrees/[id]` writes `agentInstances` and
 * `selectedAgents` from separate branches, so "roster, column still NULL" and
 * "column set, no roster" are both states the product produces routinely — an
 * implementation that checks only one of them is green on a suite that only
 * fixtures the other.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { runMigrations } from '@/lib/db/db-migrations';
import {
  applySelectedAgentsToUnchanged,
  getUnchangedAgentWorktreeIds,
  getWorktreeById,
  updateSelectedAgents,
} from '@/lib/db/worktree-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** The order the pane sends: distinct tools, primary first. */
const APPLIED: CLIToolType[] = ['codex', 'claude'];

let db: Database.Database;

/**
 * Exactly the row `upsertWorktree` leaves behind for a worktree a sync just
 * found: no `selected_agents`, no `agent_instances`.
 */
function seedWorktree(id: string): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, `/repos/${id}`, '/repos', 'repo', 1700000000000);
}

/** The raw column, read without going through the resolution layers. */
function rawSelectedAgents(id: string): string | null {
  const row = db
    .prepare('SELECT selected_agents FROM worktrees WHERE id = ?')
    .get(id) as { selected_agents: string | null } | undefined;
  return row?.selected_agents ?? null;
}

describe('getUnchangedAgentWorktreeIds / applySelectedAgentsToUnchanged (Issue #2067)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('which branches count as unchanged', () => {
    it('counts a branch with no selected_agents and no roster', () => {
      seedWorktree('pristine');
      expect(getUnchangedAgentWorktreeIds(db)).toEqual(['pristine']);
    });

    it('excludes a branch whose selected_agents column is set', () => {
      seedWorktree('column-set');
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      expect(getUnchangedAgentWorktreeIds(db)).toEqual([]);
    });

    it('excludes a branch that has agent_instances rows, column still NULL', () => {
      seedWorktree('has-roster');
      setAgentInstances(db, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
        { id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 1 },
      ]);
      // The pair this Issue shares with #2066: the column is untouched, and the
      // branch is still off-limits.
      expect(rawSelectedAgents('has-roster')).toBeNull();
      expect(getUnchangedAgentWorktreeIds(db)).toEqual([]);
    });

    it('separates the eligible from the two ineligible kinds in one install', () => {
      seedWorktree('a-pristine');
      seedWorktree('b-column-set');
      seedWorktree('c-has-roster');
      seedWorktree('d-pristine');
      updateSelectedAgents(db, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(db, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);
      expect(getUnchangedAgentWorktreeIds(db)).toEqual(['a-pristine', 'd-pristine']);
    });
  });

  describe('applying', () => {
    it('writes the order onto every unchanged branch and reports them', () => {
      seedWorktree('a-pristine');
      seedWorktree('d-pristine');
      const updated = applySelectedAgentsToUnchanged(db, APPLIED);
      expect(updated).toEqual(['a-pristine', 'd-pristine']);
      expect(JSON.parse(rawSelectedAgents('a-pristine')!)).toEqual(['codex', 'claude']);
      expect(JSON.parse(rawSelectedAgents('d-pristine')!)).toEqual(['codex', 'claude']);
    });

    it('does NOT touch a branch whose selected_agents was set by hand', () => {
      seedWorktree('column-set');
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      applySelectedAgentsToUnchanged(db, APPLIED);
      expect(JSON.parse(rawSelectedAgents('column-set')!)).toEqual(['gemini', 'opencode']);
      expect(getWorktreeById(db, 'column-set')?.selectedAgents).toEqual(['gemini', 'opencode']);
    });

    it('does NOT touch a branch that has an agent_instances roster', () => {
      seedWorktree('has-roster');
      setAgentInstances(db, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
        { id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 1 },
      ]);
      applySelectedAgentsToUnchanged(db, APPLIED);
      expect(rawSelectedAgents('has-roster')).toBeNull();
      // The visible consequence: the tabs this branch shows are still its own.
      expect(
        resolveAgentInstances(db, 'has-roster', getWorktreeById(db, 'has-roster')?.selectedAgents)
          .map((instance) => instance.cliTool)
      ).toEqual(['gemini', 'opencode']);
    });

    it('the count reported before the apply equals the rows the apply writes', () => {
      seedWorktree('a-pristine');
      seedWorktree('b-column-set');
      seedWorktree('c-has-roster');
      seedWorktree('d-pristine');
      seedWorktree('e-pristine');
      updateSelectedAgents(db, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(db, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      const previewed = getUnchangedAgentWorktreeIds(db).length;
      const updated = applySelectedAgentsToUnchanged(db, APPLIED).length;

      expect(previewed).toBe(3);
      expect(updated).toBe(previewed);
    });

    it('is idempotent: a second apply finds nothing left to change', () => {
      seedWorktree('a-pristine');
      expect(applySelectedAgentsToUnchanged(db, APPLIED)).toHaveLength(1);
      expect(getUnchangedAgentWorktreeIds(db)).toEqual([]);
      expect(applySelectedAgentsToUnchanged(db, ['gemini', 'opencode'])).toEqual([]);
      // And the second call did not quietly rewrite the first one's work.
      expect(JSON.parse(rawSelectedAgents('a-pristine')!)).toEqual(['codex', 'claude']);
    });

    it('changes the tabs an applied branch renders', () => {
      seedWorktree('pristine');
      applySelectedAgentsToUnchanged(db, APPLIED);
      expect(
        resolveAgentInstances(db, 'pristine', getWorktreeById(db, 'pristine')?.selectedAgents)
          .map((instance) => instance.cliTool)
      ).toEqual(['codex', 'claude']);
    });

    it('writes nothing when there is nothing eligible', () => {
      seedWorktree('column-set');
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      expect(applySelectedAgentsToUnchanged(db, APPLIED)).toEqual([]);
    });
  });
});
