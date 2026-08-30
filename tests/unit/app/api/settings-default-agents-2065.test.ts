/**
 * GET/PUT /api/settings/default-agents (Issue #2065).
 *
 * Runs against a REAL migrated in-memory schema rather than a mocked DB module,
 * because the two things most likely to be wrong here are both storage-shaped:
 * that `configured` distinguishes "unset" from "stored", and that `agents: null`
 * deletes the row instead of writing a copy of the constant into it. A mocked
 * `getDefaultSelectedAgents` would answer both by construction.
 *
 * The installed probe IS mocked: it shells out once per CLI tool, and this suite
 * is about the route's contract, not about what is on the machine running it.
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
import { GET, PUT, dynamic } from '@/app/api/settings/default-agents/route';
import { getDefaultSelectedAgents } from '@/lib/db/app-settings-db';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';

function get(query = '') {
  return GET(new NextRequest(`http://localhost:3000/api/settings/default-agents${query}`));
}

function put(body: unknown) {
  return PUT(
    new NextRequest('http://localhost:3000/api/settings/default-agents', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('GET/PUT /api/settings/default-agents (Issue #2065)', () => {
  beforeEach(() => {
    mocks.db = new Database(':memory:');
    runMigrations(mocks.db);
    mocks.getInstalledAgentIds.mockClear();
  });

  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
  });

  it('is force-dynamic, so the answer is not frozen at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('reports the constant with configured=false before anything is stored', async () => {
    const body = await (await get()).json();
    expect(body.success).toBe(true);
    expect(body.defaultSelectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(body.configured).toBe(false);
    expect(body.constantDefault).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(body.minAgents).toBe(2);
    expect(body.maxAgents).toBe(6);
    expect(body.available).toContain('claude');
    expect(body.available).toContain('antigravity');
  });

  it('does NOT probe installations unless asked', async () => {
    await get();
    expect(mocks.getInstalledAgentIds).not.toHaveBeenCalled();
    expect((await (await get()).json()).installed).toBeUndefined();
  });

  it('annotates with installed tools for ?include=installed', async () => {
    const body = await (await get('?include=installed')).json();
    expect(body.installed).toEqual(['claude', 'codex']);
    expect(mocks.getInstalledAgentIds).toHaveBeenCalledTimes(1);
  });

  it('saves an ordered list and reports it back as configured', async () => {
    const response = await put({ agents: ['codex', 'claude'] });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.defaultSelectedAgents).toEqual(['codex', 'claude']);
    expect(body.configured).toBe(true);
    expect(getDefaultSelectedAgents(mocks.db!)).toEqual(['codex', 'claude']);
    expect((await (await get()).json()).defaultSelectedAgents).toEqual(['codex', 'claude']);
  });

  it('preserves the order the caller sent, so [0] stays the primary', async () => {
    await put({ agents: ['gemini', 'copilot', 'claude'] });
    const body = await (await get()).json();
    expect(body.defaultSelectedAgents).toEqual(['gemini', 'copilot', 'claude']);
    expect(body.defaultSelectedAgents[0]).toBe('gemini');
  });

  it('does not probe installations on a save', async () => {
    await put({ agents: ['codex', 'claude'] });
    expect(mocks.getInstalledAgentIds).not.toHaveBeenCalled();
  });

  it('rejects a list outside 2-6, an unknown id, or a duplicate', async () => {
    for (const agents of [
      ['claude'],
      [],
      ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot', 'antigravity'],
      ['claude', 'not-a-tool'],
      ['claude', 'claude'],
      'claude',
      42,
    ]) {
      const response = await put({ agents });
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    expect(getDefaultSelectedAgents(mocks.db!)).toBeNull();
  });

  it('rejects a body with no "agents" key rather than clearing the setting', async () => {
    await put({ agents: ['codex', 'claude'] });
    const response = await put({ somethingElse: true });
    expect(response.status).toBe(400);
    expect(getDefaultSelectedAgents(mocks.db!)).toEqual(['codex', 'claude']);
  });

  /**
   * `agents: null` deletes the row. Writing the constant into it instead would
   * pass "GET now returns the constant" while quietly pinning the install to
   * today's constant forever.
   */
  it('clears the setting on agents:null by deleting the row', async () => {
    await put({ agents: ['codex', 'claude'] });
    const body = await (await put({ agents: null })).json();

    expect(body.configured).toBe(false);
    expect(body.defaultSelectedAgents).toEqual(DEFAULT_SELECTED_AGENTS);
    expect(getDefaultSelectedAgents(mocks.db!)).toBeNull();
    expect(
      mocks.db!
        .prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'default_selected_agents'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('answers 400, not 500, for a body that is not JSON', async () => {
    const response = await PUT(
      new NextRequest('http://localhost:3000/api/settings/default-agents', {
        method: 'PUT',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(response.status).toBe(400);
  });
});
