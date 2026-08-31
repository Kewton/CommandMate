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

    // The repository changes its mind. It does not reach this worktree — not
    // through the roster, and (see the H1 suite below) not through
    // `selectedAgents` either.
    declare(declaringRepo, 'agents: [gemini, copilot]\nprimary: copilot\n');
    clearRepoAgentsConfigCache();

    expect(resolveAgentInstances(db, DECLARED, getWorktreeById(db, DECLARED)?.selectedAgents))
      .toEqual(before);
    expect(resolveAgentInstances(db, DECLARED, undefined)).toEqual(before);
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
   * `resolveAgentInstances()` has NO repository layer of its own (Issue #2066
   * review, M5). The layer lives in `getWorktrees` / `getWorktreeById`, and the
   * resolver receives the result through `selectedAgents`. Pinned so that a
   * later change cannot quietly add a second entry point that no production
   * caller passes an argument to.
   */
  it('has no repository layer of its own — it receives the resolved value', () => {
    expect(resolveAgentInstances.length).toBe(3);

    // Handed the resolved value: the declaration is in force.
    expect(rosterOf(DECLARED)).toEqual(['opencode', 'codex']);
    // Handed nothing: the layers below answer, exactly as before #2066.
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

/**
 * H1 (integration review of #2066): the declaration must not leak into
 * `selectedAgents` for a worktree that already owns an `agent_instances`
 * roster.
 *
 * `resolveAgentInstances()` protects the roster with an early return, and the
 * user-facing documentation this Issue shipped promises that a branch which has
 * already opened its tabs "never changes". But `selectedAgents` is a SECOND
 * channel out of the same query, and its consumers do not look at
 * `agentInstances` at all:
 *
 *   src/app/sessions/page.tsx:341            wt.selectedAgents ?? clientDefault
 *   src/components/review/ReviewTab.tsx:246  (the same line)
 *
 * The state is not exotic. `PATCH /api/worktrees/[id]` writes `agentInstances`
 * (route.ts:208) and `selectedAgents` (route.ts:181) from INDEPENDENT branches,
 * so editing the roster in `AgentInstancesPane` leaves a row with
 * `agent_instances` rows and `selected_agents` still NULL — and a scan-created
 * worktree starts that way by construction. Before the fix, committing an
 * `agents.yaml` repainted such a worktree's chips on /sessions and /review with
 * agents it is not running, and dropped the agent it IS running out of the
 * "active agents" list.
 *
 * Fixed on the SUPPLY side rather than in the two consumers: consumers of
 * `selectedAgents` keep being added, and each new one would have to remember
 * the rule.
 */
describe('a worktree that owns a roster is not offered the declaration (Issue #2066 H1)', () => {
  const SIBLING = 'wt-sibling';

  beforeEach(() => {
    declaringRepo = makeTempDir('repo-agents-h1-declaring-2066-');
    plainRepo = makeTempDir('repo-agents-h1-plain-2066-');
    declare(declaringRepo, 'agents: [opencode, codex]\n');

    clearRepoAgentsConfigCache();
    mockLogger.warn.mockClear();
    vi.mocked(getRepoDefaultSelectedAgents).mockClear();

    db = new Database(':memory:');
    runMigrations(db);
    seedWorktree(DECLARED, declaringRepo);
    // Same repository, no roster — the control that makes the assertions below
    // about the ROSTER rather than about the repository.
    seedWorktree(SIBLING, declaringRepo);
    seedWorktree(PLAIN, plainRepo);
  });

  afterEach(() => {
    db.close();
    removeTempDir(declaringRepo);
    removeTempDir(plainRepo);
  });

  /** Exactly what the `agentInstances` branch of PATCH leaves behind. */
  function giveRoster(id: string, tool: string): void {
    setAgentInstances(db, id, [
      { id: tool, cliTool: tool as never, alias: '', order: 0 },
    ]);
    expect(
      db.prepare('SELECT selected_agents FROM worktrees WHERE id = ?').get(id)
    ).toEqual({ selected_agents: null });
  }

  it('leaves selectedAgents on the layer below for a worktree with agent_instances', () => {
    setDefaultSelectedAgents(db, ['gemini', 'claude']);
    giveRoster(DECLARED, 'codex');

    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(['gemini', 'claude']);

    const byId = new Map(getWorktrees(db).map((w) => [w.id, w.selectedAgents]));
    expect(byId.get(DECLARED)).toEqual(['gemini', 'claude']);
    // Same repository, same call, no roster: the declaration still applies.
    expect(byId.get(SIBLING)).toEqual(['opencode', 'codex']);
  });

  it('falls all the way to the constant when nothing is stored either', () => {
    giveRoster(DECLARED, 'codex');

    expect(getWorktreeById(db, DECLARED)?.selectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(getWorktrees(db).find((w) => w.id === DECLARED)?.selectedAgents)
      .toEqual(DEFAULT_SELECTED_AGENTS);
  });

  /**
   * The concrete regression: the agent actually running in this worktree must
   * stay in the list /sessions reads, and the declared agents must not appear.
   */
  it('keeps the running agent in selectedAgents rather than the declared ones', () => {
    giveRoster(DECLARED, 'codex');
    setDefaultSelectedAgents(db, ['codex', 'claude']);

    const agents = getWorktrees(db).find((w) => w.id === DECLARED)?.selectedAgents ?? [];
    expect(agents).toContain('codex');
    expect(agents).not.toContain('opencode');
  });

  it('still lets the worktree own column win over everything', () => {
    seedWorktree('wt-own-and-roster', declaringRepo, ['copilot', 'claude']);
    setAgentInstances(db, 'wt-own-and-roster', [
      { id: 'codex', cliTool: 'codex', alias: '', order: 0 },
    ]);

    expect(getWorktreeById(db, 'wt-own-and-roster')?.selectedAgents)
      .toEqual(['copilot', 'claude']);
  });

  /**
   * The withholding must not cost a query per row, and must cost nothing at all
   * on an install where no repository declares anything — which is every
   * install that has not adopted the feature.
   */
  it('probes the roster once per list, and not at all when nothing is declared', () => {
    for (let i = 0; i < 5; i++) seedWorktree(`wt-more-${i}`, declaringRepo);

    const realPrepare = db.prepare.bind(db);
    let rosterProbes = 0;
    db.prepare = ((sql: string) => {
      if (sql.includes('agent_instances')) rosterProbes++;
      return realPrepare(sql);
    }) as typeof db.prepare;

    try {
      getWorktrees(db);
      expect(rosterProbes).toBe(1);

      // Remove the declaration: the probe is not needed and must not be made.
      rosterProbes = 0;
      declare(declaringRepo, '# nothing declared here\n');
      clearRepoAgentsConfigCache();
      getWorktrees(db);
      expect(rosterProbes).toBe(0);

      // Same for the single-row read.
      rosterProbes = 0;
      getWorktreeById(db, DECLARED);
      expect(rosterProbes).toBe(0);
    } finally {
      db.prepare = realPrepare;
    }
  });
});
