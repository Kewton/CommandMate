/**
 * GET/POST /api/worktrees/apply-default-agents (Issue #2067), plus the one
 * cross-route claim this Issue has to make: that "make this the default" lands
 * where the More screen reads.
 *
 * Real migrated schema, real route modules, one shared in-memory DB — because
 * the acceptance criteria are all statements about rows. The last describe
 * block drives #2065's OWN route handlers rather than asserting on
 * `app_settings` directly: "the same key" is only worth testing as "the screen
 * that reads it sees it".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

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

const URL_BASE = 'http://localhost:3000/api/worktrees/apply-default-agents';

function seedWorktree(id: string): void {
  mocks.db!.prepare(`
    INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, `/repos/${id}`, '/repos', 'repo', 1700000000000);
}

function rawSelectedAgents(id: string): string | null {
  const row = mocks
    .db!.prepare('SELECT selected_agents FROM worktrees WHERE id = ?')
    .get(id) as { selected_agents: string | null } | undefined;
  return row?.selected_agents ?? null;
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
    mocks.db = new Database(':memory:');
    runMigrations(mocks.db);
  });

  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
  });

  it('is force-dynamic, so the count is not frozen at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  describe('GET — the count shown before the confirmation', () => {
    it('reports zero on an install with no worktrees', async () => {
      const body = await (await GET()).json();
      expect(body).toEqual({ success: true, eligible: 0 });
    });

    it('counts only branches with no selected_agents and no roster', async () => {
      seedWorktree('a-pristine');
      seedWorktree('b-column-set');
      seedWorktree('c-has-roster');
      seedWorktree('d-pristine');
      updateSelectedAgents(mocks.db!, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(mocks.db!, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      const body = await (await GET()).json();
      expect(body.eligible).toBe(2);
    });
  });

  describe('POST — the apply', () => {
    it('updates exactly the number GET previewed', async () => {
      seedWorktree('a-pristine');
      seedWorktree('b-column-set');
      seedWorktree('c-has-roster');
      seedWorktree('d-pristine');
      seedWorktree('e-pristine');
      updateSelectedAgents(mocks.db!, 'b-column-set', ['gemini', 'opencode']);
      setAgentInstances(mocks.db!, 'c-has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);

      const previewed = (await (await GET()).json()).eligible;
      const applied = await (await post({ agents: ['codex', 'claude'] })).json();

      expect(previewed).toBe(3);
      expect(applied.updated).toBe(previewed);
      expect(applied.updatedIds).toEqual(['a-pristine', 'd-pristine', 'e-pristine']);
      expect(applied.agents).toEqual(['codex', 'claude']);
    });

    it('leaves a hand-edited selected_agents branch alone', async () => {
      seedWorktree('column-set');
      updateSelectedAgents(mocks.db!, 'column-set', ['gemini', 'opencode']);
      await post({ agents: ['codex', 'claude'] });
      expect(JSON.parse(rawSelectedAgents('column-set')!)).toEqual(['gemini', 'opencode']);
    });

    it('leaves a branch that owns an agent_instances roster alone', async () => {
      seedWorktree('has-roster');
      setAgentInstances(mocks.db!, 'has-roster', [
        { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 0 },
      ]);
      await post({ agents: ['codex', 'claude'] });
      expect(rawSelectedAgents('has-roster')).toBeNull();
    });

    it('reports zero remaining, so the panel stops offering the action', async () => {
      seedWorktree('a-pristine');
      const applied = await (await post({ agents: ['codex', 'claude'] })).json();
      expect(applied.eligible).toBe(0);
      expect((await (await GET()).json()).eligible).toBe(0);
    });

    it('rejects a body without "agents" with 400 and writes nothing', async () => {
      seedWorktree('a-pristine');
      const response = await post({});
      expect(response.status).toBe(400);
      expect(rawSelectedAgents('a-pristine')).toBeNull();
    });

    it.each([
      ['one tool', ['claude']],
      ['an unknown tool', ['claude', 'not-a-tool']],
      ['a duplicate', ['claude', 'claude']],
      ['seven tools', ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'antigravity', 'vibe-local']],
    ])('rejects %s with 400 and writes nothing', async (_label, agents) => {
      seedWorktree('a-pristine');
      const response = await post({ agents });
      expect(response.status).toBe(400);
      expect(rawSelectedAgents('a-pristine')).toBeNull();
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
      seedWorktree('a-pristine');
      await SETTINGS_PUT(
        new NextRequest('http://localhost:3000/api/settings/default-agents', {
          method: 'PUT',
          body: JSON.stringify({ agents: ['codex', 'claude'] }),
          headers: { 'Content-Type': 'application/json' },
        })
      );
      // The column is what "rewrote a branch" means. Applying is this Issue's
      // separate, confirmed action — not a side effect of saving a preference.
      expect(rawSelectedAgents('a-pristine')).toBeNull();
      expect((await (await GET()).json()).eligible).toBe(1);
    });
  });
});
