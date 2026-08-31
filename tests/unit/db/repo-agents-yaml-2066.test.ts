/**
 * Issue #2066: a repository's `.commandmate/agents.yaml` decides which agents
 * its new worktrees start with — end to end against a real migrated schema and
 * real files on disk.
 *
 * The acceptance criteria are sentences about two repositories side by side, not
 * about a function, so the fixture is two repositories side by side: one that
 * declares, one that does not. Every assertion below is made on BOTH, because
 * the failure mode that matters is a layer that leaks — an implementation that
 * reads the declaring repository's file and then applies it to every worktree in
 * the sidebar is green on any single-repository test.
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

/**
 * Spied, not replaced: the real cache and the real parser stay in play (this is
 * an end-to-end suite), and the spy exists only so the "once per repository, not
 * once per row" claim can be counted. `...actual` rather than a hand-listed set
 * of exports so a later export cannot silently become undefined here.
 */
vi.mock('@/lib/repo-config/agents-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repo-config/agents-config')>();
  return {
    ...actual,
    getRepoDefaultSelectedAgents: vi.fn(actual.getRepoDefaultSelectedAgents),
  };
});

import { runMigrations } from '@/lib/db/db-migrations';
import {
  getDefaultSelectedAgents,
  setDefaultSelectedAgents,
} from '@/lib/db/app-settings-db';
import { getWorktrees, getWorktreeById } from '@/lib/db/worktree-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import {
  clearRepoAgentsConfigCache,
  getRepoDefaultSelectedAgents,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
} from '@/lib/repo-config/agents-config';

const DECLARED = 'wt-declaring';
const PLAIN = 'wt-plain';

/** Repository that ships a declaration. */
let declaringRepo: string;
/** Repository that ships none — the control. */
let plainRepo: string;
let db: Database.Database;

function declare(root: string, contents: string): void {
  mkdirSync(join(root, '.commandmate'), { recursive: true });
  writeFileSync(join(root, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
}

/**
 * Exactly the row `upsertWorktree` leaves behind for a worktree a sync just
 * found: a `repository_path`, no `selected_agents`, and no `agent_instances`.
 */
function seedWorktree(
  id: string,
  repositoryPath: string,
  selectedAgents?: string[]
): void {
  db.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, selected_agents, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    id,
    join(repositoryPath, id),
    repositoryPath,
    'repo',
    selectedAgents ? JSON.stringify(selectedAgents) : null,
    1700000000000
  );
}

function rosterOf(id: string): string[] {
  return resolveAgentInstances(db, id, getWorktreeById(db, id)?.selectedAgents)
    .map((instance) => instance.cliTool);
}

describe('the repository declaration reaches its own worktrees (Issue #2066 acceptance)', () => {
  beforeEach(() => {
    declaringRepo = makeTempDir('repo-agents-declaring-2066-');
    plainRepo = makeTempDir('repo-agents-plain-2066-');
    declare(declaringRepo, 'agents: [opencode, codex]\n');

    clearRepoAgentsConfigCache();
    mockLogger.warn.mockClear();
    vi.mocked(getRepoDefaultSelectedAgents).mockClear();

    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(DECLARED, declaringRepo);
    seedWorktree(PLAIN, plainRepo);
  });

  afterEach(() => {
    db.close();
    removeTempDir(declaringRepo);
    removeTempDir(plainRepo);
  });

  it('gives the declaring repository the declared order, opencode primary', () => {
    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['opencode', 'codex']);

    const roster = resolveAgentInstances(db, DECLARED, getWorktreeById(db, DECLARED)?.selectedAgents);
    expect(roster.map((i) => i.cliTool)).toEqual(['opencode', 'codex']);
    expect(roster[0].id).toBe('opencode');
    expect(roster.map((i) => i.order)).toEqual([0, 1]);
  });

  it('honours `primary` when the declaration names one', () => {
    declare(declaringRepo, 'agents: [opencode, codex, claude]\nprimary: claude\n');
    clearRepoAgentsConfigCache();

    expect(getWorktreeById(db, DECLARED)?.selectedAgents)
      .toEqual(['claude', 'opencode', 'codex']);
    expect(rosterOf(DECLARED)[0]).toBe('claude');
  });

  /**
   * The other half of the first acceptance criterion, and the one a leaking
   * implementation fails: the repository next door still answers to #2065.
   */
  it('leaves every other repository on the #2065 setting', () => {
    setDefaultSelectedAgents(db, ['gemini', 'claude']);

    expect(getWorktreeById(db, PLAIN)?.selectedAgents).toEqual(['gemini', 'claude']);
    expect(rosterOf(PLAIN)).toEqual(['gemini', 'claude']);

    // ...and the declaring repository still outranks that setting.
    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['opencode', 'codex']);
    expect(rosterOf(DECLARED)).toEqual(['opencode', 'codex']);
  });

  it('reports both repositories correctly from one getWorktrees() call', () => {
    setDefaultSelectedAgents(db, ['gemini', 'claude']);

    const byId = new Map(getWorktrees(db).map((w) => [w.id, w.selectedAgents]));
    expect(byId.get(DECLARED)).toEqual(['opencode', 'codex']);
    expect(byId.get(PLAIN)).toEqual(['gemini', 'claude']);
  });

  /**
   * The full chain, asserted as a chain. Each line removes one layer and the
   * answer must step down exactly one rung.
   */
  it('resolves worktree -> repo file -> app_settings -> constant, in that order', () => {
    setDefaultSelectedAgents(db, ['gemini', 'claude']);
    seedWorktree('wt-own-choice', declaringRepo, ['copilot', 'claude']);

    // worktree column wins over the repository file
    expect(getWorktreeById(db, 'wt-own-choice')?.selectedAgents).toEqual(['copilot', 'claude']);
    // repository file wins over app_settings
    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['opencode', 'codex']);
    // app_settings wins over the constant
    expect(getWorktreeById(db, PLAIN)?.selectedAgents).toEqual(['gemini', 'claude']);
  });

  /**
   * The second acceptance criterion. `agent_instances` is the authority once
   * rows exist — including aliases the user created — so a repository adopting a
   * declaration must be invisible to every branch already open.
   */
  it('never rewrites an existing agent_instances roster', () => {
    setAgentInstances(db, DECLARED, [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'review', order: 1 },
    ]);
    const before = resolveAgentInstances(db, DECLARED, getWorktreeById(db, DECLARED)?.selectedAgents);
    // Guard against a vacuous comparison: the roster really is the stored one,
    // user alias and all, and shares nothing with the declaration.
    expect(before.map((i) => i.id)).toEqual(['claude', 'claude-2']);
    expect(before.map((i) => i.alias)).toEqual(['Claude', 'review']);

    // The repository changes its mind, twice over. Neither reaches this worktree.
    declare(declaringRepo, 'agents: [gemini, copilot]\nprimary: copilot\n');
    clearRepoAgentsConfigCache();
    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['copilot', 'gemini']);

    expect(resolveAgentInstances(db, DECLARED, getWorktreeById(db, DECLARED)?.selectedAgents))
      .toEqual(before);
    expect(resolveAgentInstances(db, DECLARED, undefined, declaringRepo)).toEqual(before);
  });

  /**
   * The third acceptance criterion. A repository must not be able to blank its
   * own tab strip by committing a typo, and the operator must be able to find
   * out why the file is being ignored.
   */
  it('warns and falls through to app_settings when the declaration is broken', () => {
    declare(declaringRepo, 'agents: [opencode, codex\n');
    clearRepoAgentsConfigCache();
    setDefaultSelectedAgents(db, ['gemini', 'claude']);

    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['gemini', 'claude']);
    expect(rosterOf(DECLARED)).toEqual(['gemini', 'claude']);
    expect(mockLogger.warn.mock.calls.map((c) => c[0])).toContain('repo-agents:yaml-parse-failed');
  });

  it('warns and falls through to the constant when the values are invalid and nothing is stored', () => {
    declare(declaringRepo, 'agents: [opencode, not-a-tool]\n');
    clearRepoAgentsConfigCache();

    expect(getDefaultSelectedAgents(db)).toBeNull();
    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(rosterOf(DECLARED)).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(mockLogger.warn.mock.calls.map((c) => c[0])).toContain('repo-agents:invalid-agents');
  });

  /**
   * The fourth acceptance criterion, stated as a property of the code path
   * rather than left to the pre-existing suites: with no file anywhere, every
   * answer is the one #2065 gave.
   */
  it('is unchanged from before the Issue when no repository declares anything', () => {
    expect(getWorktreeById(db, PLAIN)?.selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(rosterOf(PLAIN)).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(resolveAgentInstances(db, PLAIN, undefined).map((i) => i.cliTool))
      .toEqual(DEFAULT_SELECTED_AGENTS);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  /**
   * `resolveAgentInstances`'s own repository layer, exercised directly.
   *
   * Every production caller hands it `worktree.selectedAgents`, which the DB
   * read has already resolved, so that path tests the DB layer twice and the
   * resolver's layer not at all. `undefined` is the input that reaches it:
   * `PATCH /api/worktrees/[id]` passes `updatedWorktree?.selectedAgents`.
   */
  it('answers from the repository declaration when the caller has no selectedAgents', () => {
    expect(resolveAgentInstances(db, DECLARED, undefined, declaringRepo).map((i) => i.cliTool))
      .toEqual(['opencode', 'codex']);
    // ...and without the repository path it falls to the layers below, unchanged.
    expect(resolveAgentInstances(db, DECLARED, undefined).map((i) => i.cliTool))
      .toEqual(DEFAULT_SELECTED_AGENTS);
  });

  /**
   * `getWorktrees` memoizes per distinct `repository_path`. Asserted by counting,
   * because the cheap wrong version (asking per row) is green on every value
   * assertion above and only shows up as N lookups on a sidebar poll — the exact
   * shape #1913's rule exists to prevent.
   */
  it('asks each repository once per getWorktrees() call, not once per row', () => {
    for (let i = 0; i < 4; i++) seedWorktree(`wt-declaring-${i}`, declaringRepo);
    for (let i = 0; i < 4; i++) seedWorktree(`wt-plain-${i}`, plainRepo);

    vi.mocked(getRepoDefaultSelectedAgents).mockClear();
    const rows = getWorktrees(db);

    expect(rows.length).toBe(10);
    expect(vi.mocked(getRepoDefaultSelectedAgents)).toHaveBeenCalledTimes(2);
  });

  it('never asks for a worktree row that has no repository_path', () => {
    db.prepare(`
      INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)
    `).run('wt-orphan', 'wt-orphan', '/tmp/wt-orphan', 1700000000000);

    vi.mocked(getRepoDefaultSelectedAgents).mockClear();
    const orphan = getWorktrees(db).find((w) => w.id === 'wt-orphan');

    expect(orphan?.selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(vi.mocked(getRepoDefaultSelectedAgents).mock.calls.map((c) => c[0]))
      .not.toContain(null);
  });
});
