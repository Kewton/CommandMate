/**
 * Issue #2067: "apply this agent order to the branches I already have", and the
 * three rules that make it safe — it stays inside ONE repository, it never
 * rewrites a branch the user has touched, and it is all-or-nothing.
 *
 * Run against a REAL migrated schema and REAL repository directories on disk,
 * because every claim here is a claim about two columns in two tables
 * (`worktrees.selected_agents`, the presence of `agent_instances` rows) and one
 * file (`.commandmate/agents.yaml`). A mocked `findUnchangedAgentWorktrees`
 * would answer all of them by construction.
 *
 * The fixture is TWO repositories side by side, and every scoping assertion is
 * made on both: an implementation that scans `worktrees` whole is green on any
 * single-repository suite. That is exactly how the first revision of this
 * feature shipped — the button lived in one worktree's pane and rewrote every
 * repository on the machine.
 *
 * "Touched" has two independent spellings and they get their own tests on
 * purpose. `PATCH /api/worktrees/[id]` writes `agentInstances` and
 * `selectedAgents` from separate branches, so "roster, column still NULL" and
 * "column set, no roster" are both states the product produces routinely.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../../helpers/temp-dir';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { runMigrations } from '@/lib/db/db-migrations';
import {
  applySelectedAgentsToUnchanged,
  findUnchangedAgentWorktrees,
  getWorktreeById,
  updateSelectedAgents,
} from '@/lib/db/worktree-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import {
  clearRepoAgentsConfigCache,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
} from '@/lib/repo-config/agents-config';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** The order the pane sends: distinct tools, primary first. */
const APPLIED: CLIToolType[] = ['codex', 'claude'];

let db: Database.Database;
/** The repository the button was pressed in. */
let repoA: string;
/** A second repository that must never be touched from repository A's pane. */
let repoB: string;

/**
 * Exactly the row `upsertWorktree` leaves behind for a worktree a sync just
 * found: a `repository_path`, no `selected_agents`, no `agent_instances`.
 */
function seedWorktree(id: string, repositoryPath: string): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, join(repositoryPath, id), repositoryPath, 'repo', 1700000000000);
}

function declare(root: string, contents: string): void {
  mkdirSync(join(root, '.commandmate'), { recursive: true });
  writeFileSync(join(root, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
  clearRepoAgentsConfigCache();
}

/** The raw column, read without going through the resolution layers. */
function rawSelectedAgents(id: string): string | null {
  const row = db
    .prepare('SELECT selected_agents FROM worktrees WHERE id = ?')
    .get(id) as { selected_agents: string | null } | undefined;
  return row?.selected_agents ?? null;
}

describe('findUnchangedAgentWorktrees / applySelectedAgentsToUnchanged (Issue #2067)', () => {
  beforeEach(() => {
    repoA = makeTempDir('agent-defaults-repo-a-2067-');
    repoB = makeTempDir('agent-defaults-repo-b-2067-');
    clearRepoAgentsConfigCache();
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    removeTempDir(repoA);
    removeTempDir(repoB);
    clearRepoAgentsConfigCache();
  });

  describe('the scan stays inside one repository', () => {
    it('counts only the calling repository, never the install', () => {
      seedWorktree('a1', repoA);
      seedWorktree('a2', repoA);
      seedWorktree('b1', repoB);
      seedWorktree('b2', repoB);

      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual(['a1', 'a2']);
      expect(findUnchangedAgentWorktrees(db, repoB).ids).toEqual(['b1', 'b2']);
    });

    it('leaves another repository’s unchanged worktrees untouched', () => {
      seedWorktree('a1', repoA);
      seedWorktree('b1', repoB);
      seedWorktree('b2', repoB);

      const updated = applySelectedAgentsToUnchanged(db, repoA, APPLIED);

      expect(updated).toEqual(['a1']);
      expect(JSON.parse(rawSelectedAgents('a1')!)).toEqual(['codex', 'claude']);
      // The regression this Issue's review caught: pressing the button in one
      // repository's pane rewrote every other repository on the machine.
      expect(rawSelectedAgents('b1')).toBeNull();
      expect(rawSelectedAgents('b2')).toBeNull();
    });

    it('reports nothing for a repository that has no worktrees', () => {
      seedWorktree('a1', repoA);
      const found = findUnchangedAgentWorktrees(db, repoB);
      expect(found.ids).toEqual([]);
      expect(found.repositoryPath).toBe(repoB);
    });
  });

  describe('a repository that declares its agents (Issue #2066) is off-limits', () => {
    it('reports repoDeclares and no eligible worktrees', () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);
      seedWorktree('a2', repoA);

      const found = findUnchangedAgentWorktrees(db, repoA);
      expect(found.repoDeclares).toBe(true);
      expect(found.ids).toEqual([]);
    });

    it('writes nothing, so the committed declaration keeps deciding the tabs', () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);

      expect(applySelectedAgentsToUnchanged(db, repoA, APPLIED)).toEqual([]);
      // The column staying NULL is the whole point: `SELECTED_AGENTS_LAYERS`
      // puts it ABOVE the repository file, so writing it here would retire the
      // declaration for this branch permanently.
      expect(rawSelectedAgents('a1')).toBeNull();
      expect(getWorktreeById(db, 'a1')?.selectedAgents).toEqual(['gemini', 'opencode']);
    });

    it('does not stop the OTHER repository from being applied to', () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);
      seedWorktree('b1', repoB);

      const found = findUnchangedAgentWorktrees(db, repoB);
      expect(found.repoDeclares).toBe(false);
      expect(applySelectedAgentsToUnchanged(db, repoB, APPLIED)).toEqual(['b1']);
      expect(rawSelectedAgents('a1')).toBeNull();
    });
  });

  describe('which branches count as unchanged', () => {
    it('counts a branch with no selected_agents and no roster', () => {
      seedWorktree('pristine', repoA);
      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual(['pristine']);
    });

    it('excludes a branch whose selected_agents column is set', () => {
      seedWorktree('column-set', repoA);
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual([]);
    });

    it('excludes a branch that has agent_instances rows, column still NULL', () => {
      seedWorktree('has-roster', repoA);
      setAgentInstances(db, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
        { id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 1 },
      ]);
      // The pair this Issue shares with #2066: the column is untouched, and the
      // branch is still off-limits.
      expect(rawSelectedAgents('has-roster')).toBeNull();
      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual([]);
    });

    it('separates the eligible from the two ineligible kinds in one repository', () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('b-column-set', repoA);
      seedWorktree('c-has-roster', repoA);
      seedWorktree('d-pristine', repoA);
      updateSelectedAgents(db, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(db, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);
      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual(['a-pristine', 'd-pristine']);
    });
  });

  describe('applying', () => {
    it('writes the order onto every unchanged branch and reports them', () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('d-pristine', repoA);
      const updated = applySelectedAgentsToUnchanged(db, repoA, APPLIED);
      expect(updated).toEqual(['a-pristine', 'd-pristine']);
      expect(JSON.parse(rawSelectedAgents('a-pristine')!)).toEqual(['codex', 'claude']);
      expect(JSON.parse(rawSelectedAgents('d-pristine')!)).toEqual(['codex', 'claude']);
    });

    it('does NOT touch a branch whose selected_agents was set by hand', () => {
      seedWorktree('column-set', repoA);
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      applySelectedAgentsToUnchanged(db, repoA, APPLIED);
      expect(JSON.parse(rawSelectedAgents('column-set')!)).toEqual(['gemini', 'opencode']);
      expect(getWorktreeById(db, 'column-set')?.selectedAgents).toEqual(['gemini', 'opencode']);
    });

    it('does NOT touch a branch that has an agent_instances roster', () => {
      seedWorktree('has-roster', repoA);
      setAgentInstances(db, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
        { id: 'opencode', cliTool: 'opencode', alias: 'opencode', order: 1 },
      ]);
      applySelectedAgentsToUnchanged(db, repoA, APPLIED);
      expect(rawSelectedAgents('has-roster')).toBeNull();
      // The visible consequence: the tabs this branch shows are still its own.
      expect(
        resolveAgentInstances(db, 'has-roster', getWorktreeById(db, 'has-roster')?.selectedAgents)
          .map((instance) => instance.cliTool)
      ).toEqual(['gemini', 'opencode']);
    });

    it('the count reported before the apply equals the rows the apply writes', () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('b-column-set', repoA);
      seedWorktree('c-has-roster', repoA);
      seedWorktree('d-pristine', repoA);
      seedWorktree('e-pristine', repoA);
      seedWorktree('z-other-repo', repoB);
      updateSelectedAgents(db, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(db, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      const previewed = findUnchangedAgentWorktrees(db, repoA).ids.length;
      const updated = applySelectedAgentsToUnchanged(db, repoA, APPLIED).length;

      expect(previewed).toBe(3);
      expect(updated).toBe(previewed);
    });

    it('is idempotent: a second apply finds nothing left to change', () => {
      seedWorktree('a-pristine', repoA);
      expect(applySelectedAgentsToUnchanged(db, repoA, APPLIED)).toHaveLength(1);
      expect(findUnchangedAgentWorktrees(db, repoA).ids).toEqual([]);
      expect(applySelectedAgentsToUnchanged(db, repoA, ['gemini', 'opencode'])).toEqual([]);
      // And the second call did not quietly rewrite the first one's work.
      expect(JSON.parse(rawSelectedAgents('a-pristine')!)).toEqual(['codex', 'claude']);
    });

    it('changes the tabs an applied branch renders', () => {
      seedWorktree('pristine', repoA);
      applySelectedAgentsToUnchanged(db, repoA, APPLIED);
      expect(
        resolveAgentInstances(db, 'pristine', getWorktreeById(db, 'pristine')?.selectedAgents)
          .map((instance) => instance.cliTool)
      ).toEqual(['codex', 'claude']);
    });

    it('writes nothing when there is nothing eligible', () => {
      seedWorktree('column-set', repoA);
      updateSelectedAgents(db, 'column-set', ['gemini', 'opencode']);
      expect(applySelectedAgentsToUnchanged(db, repoA, APPLIED)).toEqual([]);
    });
  });

  describe('the apply is all-or-nothing', () => {
    it('rolls the earlier rows back when a later one fails', () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('b-pristine', repoA);
      seedWorktree('c-boom', repoA);

      // A write that fails partway is the case the transaction exists for: a
      // locked database, a constraint, a trigger. A trigger is the one a test
      // can produce deterministically, and it aborts the THIRD row so the first
      // two have already been written when it fires.
      db.exec(`
        CREATE TEMP TRIGGER agent_defaults_2067_boom
        BEFORE UPDATE ON worktrees
        WHEN NEW.id = 'c-boom'
        BEGIN SELECT RAISE(ABORT, 'boom'); END;
      `);

      expect(() => applySelectedAgentsToUnchanged(db, repoA, APPLIED)).toThrow(/boom/);

      // Without the transaction, a-pristine and b-pristine would be committed
      // and the repository would be left half-applied with nothing on screen
      // saying which half.
      expect(rawSelectedAgents('a-pristine')).toBeNull();
      expect(rawSelectedAgents('b-pristine')).toBeNull();
      expect(rawSelectedAgents('c-boom')).toBeNull();
    });
  });
});
