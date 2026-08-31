/**
 * GET/POST /api/worktrees/apply-default-agents (Issue #2067), plus the one
 * cross-route claim this Issue has to make: that "make this the default" lands
 * where the More screen reads.
 *
 * Real migrated schema, real route modules, real repository directories, one
 * shared in-memory DB — because the acceptance criteria are all statements about
 * rows. Two repositories side by side throughout: the defect this suite exists
 * to prevent is a route that answers for the whole install when it was asked
 * about one worktree.
 *
 * The last describe block drives #2065's OWN route handlers rather than
 * asserting on `app_settings` directly: "the same key" is only worth testing as
 * "the screen that reads it sees it".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '../../../helpers/temp-dir';

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  getInstalledAgentIds: vi.fn(async () => ['claude', 'codex'] as string[]),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => mocks.db }));
vi.mock('@/config/installed-agents-cache', () => ({
  getInstalledAgentIds: mocks.getInstalledAgentIds,
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { GET, POST, dynamic } from '@/app/api/worktrees/apply-default-agents/route';
import {
  GET as SETTINGS_GET,
  PUT as SETTINGS_PUT,
} from '@/app/api/settings/default-agents/route';
import { updateSelectedAgents } from '@/lib/db/worktree-db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import {
  clearRepoAgentsConfigCache,
  REPO_AGENTS_CONFIG_RELATIVE_PATH,
} from '@/lib/repo-config/agents-config';

const URL_BASE = 'http://localhost:3000/api/worktrees/apply-default-agents';

/** The repository the pane the button lives in belongs to. */
let repoA: string;
/** A second repository, which the button must never reach. */
let repoB: string;

function seedWorktree(id: string, repositoryPath: string, repositoryName = 'repo'): void {
  mocks.db!.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, join(repositoryPath, id), repositoryPath, repositoryName, 1700000000000);
}

function declare(root: string, contents: string): void {
  mkdirSync(join(root, '.commandmate'), { recursive: true });
  writeFileSync(join(root, REPO_AGENTS_CONFIG_RELATIVE_PATH), contents, 'utf8');
  clearRepoAgentsConfigCache();
}

function rawSelectedAgents(id: string): string | null {
  const row = mocks
    .db!.prepare('SELECT selected_agents FROM worktrees WHERE id = ?')
    .get(id) as { selected_agents: string | null } | undefined;
  return row?.selected_agents ?? null;
}

function get(worktreeId?: string) {
  const query = worktreeId === undefined ? '' : `?worktreeId=${encodeURIComponent(worktreeId)}`;
  return GET(new NextRequest(`${URL_BASE}${query}`));
}

function post(body: unknown) {
  return POST(
    new NextRequest(URL_BASE, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('GET/POST /api/worktrees/apply-default-agents (Issue #2067)', () => {
  beforeEach(() => {
    repoA = makeTempDir('agent-defaults-route-a-2067-');
    repoB = makeTempDir('agent-defaults-route-b-2067-');
    clearRepoAgentsConfigCache();
    mocks.db = new Database(':memory:');
    runMigrations(mocks.db);
  });

  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
    removeTempDir(repoA);
    removeTempDir(repoB);
    clearRepoAgentsConfigCache();
  });

  it('is force-dynamic, so the count is not frozen at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  describe('the calling worktree bounds the answer', () => {
    it('rejects a GET with no worktreeId rather than answering for the install', async () => {
      seedWorktree('a1', repoA);
      const response = await get();
      expect(response.status).toBe(400);
    });

    it('rejects a POST with no worktreeId and writes nothing', async () => {
      seedWorktree('a1', repoA);
      const response = await post({ agents: ['codex', 'claude'] });
      expect(response.status).toBe(400);
      expect(rawSelectedAgents('a1')).toBeNull();
    });

    it('404s on an unknown worktree', async () => {
      expect((await get('nope')).status).toBe(404);
      expect((await post({ worktreeId: 'nope', agents: ['codex', 'claude'] })).status).toBe(404);
    });

    it('counts only the calling worktree’s repository', async () => {
      seedWorktree('a1', repoA, 'Repo A');
      seedWorktree('a2', repoA, 'Repo A');
      seedWorktree('b1', repoB, 'Repo B');
      seedWorktree('b2', repoB, 'Repo B');
      seedWorktree('b3', repoB, 'Repo B');

      const fromA = await (await get('a1')).json();
      expect(fromA.eligible).toBe(2);
      expect(fromA.repositoryPath).toBe(repoA);
      expect(fromA.repositoryName).toBe('Repo A');

      const fromB = await (await get('b1')).json();
      expect(fromB.eligible).toBe(3);
      expect(fromB.repositoryName).toBe('Repo B');
    });

    it('applies inside the calling repository and leaves the other one alone', async () => {
      seedWorktree('a1', repoA);
      seedWorktree('a2', repoA);
      seedWorktree('b1', repoB);

      const applied = await (await post({ worktreeId: 'a1', agents: ['codex', 'claude'] })).json();

      expect(applied.updated).toBe(2);
      expect(applied.updatedIds).toEqual(['a1', 'a2']);
      expect(JSON.parse(rawSelectedAgents('a2')!)).toEqual(['codex', 'claude']);
      expect(rawSelectedAgents('b1')).toBeNull();
    });
  });

  describe('a repository that declares its agents (#2066)', () => {
    it('reports repoDeclaresAgents with zero eligible', async () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);
      seedWorktree('a2', repoA);

      const body = await (await get('a1')).json();
      expect(body.repoDeclaresAgents).toBe(true);
      expect(body.eligible).toBe(0);
    });

    it('writes nothing, so the committed declaration survives', async () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);

      const applied = await (await post({ worktreeId: 'a1', agents: ['codex', 'claude'] })).json();
      expect(applied.updated).toBe(0);
      expect(applied.repoDeclaresAgents).toBe(true);
      expect(rawSelectedAgents('a1')).toBeNull();
    });

    it('does not disable the action in a repository that declares nothing', async () => {
      declare(repoA, 'agents: [gemini, opencode]\n');
      seedWorktree('a1', repoA);
      seedWorktree('b1', repoB);

      const body = await (await get('b1')).json();
      expect(body.repoDeclaresAgents).toBe(false);
      expect(body.eligible).toBe(1);
    });
  });

  describe('GET — the count shown before the confirmation', () => {
    it('reports zero when the repository has only touched branches', async () => {
      seedWorktree('a1', repoA);
      updateSelectedAgents(mocks.db!, 'a1', ['gemini', 'opencode']);
      expect((await (await get('a1')).json()).eligible).toBe(0);
    });

    it('counts only branches with no selected_agents and no roster', async () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('b-column-set', repoA);
      seedWorktree('c-has-roster', repoA);
      seedWorktree('d-pristine', repoA);
      updateSelectedAgents(mocks.db!, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(mocks.db!, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      expect((await (await get('a-pristine')).json()).eligible).toBe(2);
    });
  });

  describe('POST — the apply', () => {
    it('updates exactly the number GET previewed', async () => {
      seedWorktree('a-pristine', repoA);
      seedWorktree('b-column-set', repoA);
      seedWorktree('c-has-roster', repoA);
      seedWorktree('d-pristine', repoA);
      seedWorktree('e-pristine', repoA);
      seedWorktree('z-other-repo', repoB);
      updateSelectedAgents(mocks.db!, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(mocks.db!, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      const previewed = (await (await get('a-pristine')).json()).eligible;
      const applied = await (
        await post({ worktreeId: 'a-pristine', agents: ['codex', 'claude'] })
      ).json();

      expect(previewed).toBe(3);
      expect(applied.updated).toBe(previewed);
      expect(applied.updatedIds).toEqual(['a-pristine', 'd-pristine', 'e-pristine']);
      expect(applied.agents).toEqual(['codex', 'claude']);
      expect(rawSelectedAgents('z-other-repo')).toBeNull();
    });

    it('leaves a hand-edited selected_agents branch alone', async () => {
      seedWorktree('a1', repoA);
      seedWorktree('column-set', repoA);
      updateSelectedAgents(mocks.db!, 'column-set', ['gemini', 'opencode']);
      await post({ worktreeId: 'a1', agents: ['codex', 'claude'] });
      expect(JSON.parse(rawSelectedAgents('column-set')!)).toEqual(['gemini', 'opencode']);
    });

    it('leaves a branch that owns an agent_instances roster alone', async () => {
      seedWorktree('a1', repoA);
      seedWorktree('has-roster', repoA);
      setAgentInstances(mocks.db!, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);
      await post({ worktreeId: 'a1', agents: ['codex', 'claude'] });
      expect(rawSelectedAgents('has-roster')).toBeNull();
    });

    it('reports zero remaining, so the panel stops offering the action', async () => {
      seedWorktree('a1', repoA);
      const applied = await (await post({ worktreeId: 'a1', agents: ['codex', 'claude'] })).json();
      expect(applied.eligible).toBe(0);
      expect((await (await get('a1')).json()).eligible).toBe(0);
    });

    it('rejects a body without "agents" with 400 and writes nothing', async () => {
      seedWorktree('a1', repoA);
      const response = await post({ worktreeId: 'a1' });
      expect(response.status).toBe(400);
      expect(rawSelectedAgents('a1')).toBeNull();
    });

    it.each([
      ['one tool', ['claude']],
      ['an unknown tool', ['claude', 'not-a-tool']],
      ['a duplicate', ['claude', 'claude']],
      ['seven tools', ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity', 'vibe-local']],
    ])('rejects %s with 400 and writes nothing', async (_label, agents) => {
      seedWorktree('a1', repoA);
      const response = await post({ worktreeId: 'a1', agents });
      expect(response.status).toBe(400);
      expect(rawSelectedAgents('a1')).toBeNull();
    });
  });

  describe('"make this the default" lands where the More screen reads it', () => {
    it('a PUT of the pane roster is what the settings GET then reports', async () => {
      // What the pane sends when its roster is Codex, Claude.
      const put = await SETTINGS_PUT(
        new NextRequest('http://localhost:3000/api/settings/default-agents', {
          method: 'PUT',
          body: JSON.stringify({ agents: ['codex', 'claude'] }),
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(put.status).toBe(200);

      // What the More screen loads on its next visit.
      const settings = await (
        await SETTINGS_GET(
          new NextRequest('http://localhost:3000/api/settings/default-agents')
        )
      ).json();
      expect(settings.defaultSelectedAgents).toEqual(['codex', 'claude']);
      expect(settings.configured).toBe(true);
    });

    it('saving the default does NOT itself rewrite existing branches (#2065 unchanged)', async () => {
      seedWorktree('a1', repoA);
      await SETTINGS_PUT(
        new NextRequest('http://localhost:3000/api/settings/default-agents', {
          method: 'PUT',
          body: JSON.stringify({ agents: ['codex', 'claude'] }),
          headers: { 'Content-Type': 'application/json' },
        })
      );
      // The column is what "rewrote a branch" means. Applying is this Issue's
      // separate, confirmed action — not a side effect of saving a preference.
      expect(rawSelectedAgents('a1')).toBeNull();
      expect((await (await get('a1')).json()).eligible).toBe(1);
    });
  });
});
