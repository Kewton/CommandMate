/**
 * `GET` / `PUT /api/worktrees/:id/instances/opencode` (Issue #2048).
 *
 * The route is the only writer of `opencode_instance_settings`, so it is the
 * boundary where an HTTP body becomes something `prepareOpencodeLaunch`
 * interpolates into a **shell command line**. Two of the tests below are about
 * exactly that, and the rest are about the two ways the route says "no": an
 * instance that is not in the roster, and one that is but is not an opencode.
 *
 * The catalogue half is asserted through its degraded path — no port assigned,
 * so no server to ask — because that is the state a worktree is in whenever its
 * panes are stopped, and the pane's fallback to free text depends on the route
 * reporting it honestly rather than erroring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances, getOpencodeInstanceSettings } from '@/lib/db/agent-instances-db';
import { EMPTY_OPENCODE_INSTANCE_SETTINGS } from '@/types/opencode-instance-settings';
import {
  getOpencodeLaunchSettings,
  resetOpencodeLaunchSettings,
} from '@/lib/hooks/sources/opencode/launch-settings';
import type { Worktree } from '@/types/models';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

import { GET, PUT } from '@/app/api/worktrees/[id]/instances/opencode/route';
import type { NextRequest } from 'next/server';

const WT = 'wt-2048-api';

/** A fresh promise per call — Next hands the route a new one each time. */
function params() {
  return { params: Promise.resolve({ id: WT }) };
}

function putRequest(body: unknown): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/instances/opencode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function getRequest(): NextRequest {
  return new Request(
    `http://localhost:3000/api/worktrees/${WT}/instances/opencode`
  ) as unknown as NextRequest;
}

describe('/api/worktrees/:id/instances/opencode (Issue #2048)', () => {
  let db: Database.Database;
  /** The route writes the launcher's mirror under `~/.commandmate`; sandbox it. */
  let sandbox: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'cm-2048-api-'));
    vi.stubEnv(
      'CM_OPENCODE_LAUNCH_SETTINGS_FILE',
      join(sandbox, 'opencode-launch-settings.json')
    );
    resetOpencodeLaunchSettings();
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WT,
      name: WT,
      path: `/tmp/${WT}`,
      repositoryPath: '/tmp/repo',
      repositoryName: 'repo',
      cliToolId: 'opencode',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WT, [
      { id: 'opencode', cliTool: 'opencode', alias: '', order: 0 },
      { id: 'claude', cliTool: 'claude', alias: '', order: 1 },
    ]);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    resetOpencodeLaunchSettings();
    vi.unstubAllEnvs();
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('GET answers one entry per opencode instance, and none for other tools', async () => {
    const response = await GET(getRequest(), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.settings)).toEqual(['opencode']);
    expect(body.settings.opencode).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('GET reports an unreachable catalogue as `connected: false` rather than failing', async () => {
    const response = await GET(getRequest(), params());
    const body = await response.json();
    expect(body.catalog).toEqual({ connected: false, providers: [], agents: [] });
  });

  it('PUT stores the settings and GET reads them back', async () => {
    const put = await PUT(
      putRequest({
        instanceId: 'opencode',
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'high',
      }),
      params()
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      instanceId: 'opencode',
      settings: {
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'high',
      },
    });

    const body = await (await GET(getRequest(), params())).json();
    expect(body.settings.opencode.variant).toBe('high');
  });

  it('PUT writes the launcher s mirror, which is what the launch line reads', async () => {
    await PUT(
      putRequest({
        instanceId: 'opencode',
        agent: 'plan',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
        variant: 'high',
      }),
      params()
    );
    resetOpencodeLaunchSettings();
    expect(
      getOpencodeLaunchSettings({
        worktreeId: WT,
        cliToolId: 'opencode',
        instanceId: 'opencode',
      })
    ).toEqual({
      agent: 'plan',
      providerId: 'github-copilot',
      modelId: 'claude-sonnet-4.6',
      variant: 'high',
    });
  });

  it('GET reconciles a mirror the rows have moved away from', async () => {
    await PUT(putRequest({ instanceId: 'opencode', agent: 'plan' }), params());
    // Something changed the rows without going through this route — a restored
    // database, or a worktree id rename that moved the rows and not the mirror.
    db.prepare('DELETE FROM opencode_instance_settings WHERE worktree_id = ?').run(WT);
    resetOpencodeLaunchSettings();

    await GET(getRequest(), params());

    resetOpencodeLaunchSettings();
    expect(
      getOpencodeLaunchSettings({
        worktreeId: WT,
        cliToolId: 'opencode',
        instanceId: 'opencode',
      })
    ).toEqual(EMPTY_OPENCODE_INSTANCE_SETTINGS);
  });

  it('PUT drops a value that must never reach a shell, and says what it stored', async () => {
    const response = await PUT(
      putRequest({
        instanceId: 'opencode',
        agent: '$(touch /tmp/pwned-2048)',
        providerId: 'github-copilot',
        modelId: 'claude-sonnet-4.6',
      }),
      params()
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.settings.agent).toBeNull();
    expect(getOpencodeInstanceSettings(db, WT, 'opencode').agent).toBeNull();
  });

  it('PUT clears the row when everything is unset', async () => {
    await PUT(putRequest({ instanceId: 'opencode', agent: 'plan' }), params());
    await PUT(putRequest({ instanceId: 'opencode' }), params());
    expect(getOpencodeInstanceSettings(db, WT, 'opencode')).toEqual(
      EMPTY_OPENCODE_INSTANCE_SETTINGS
    );
  });

  it('PUT refuses an instance the roster does not hold', async () => {
    const response = await PUT(putRequest({ instanceId: 'opencode-9', agent: 'plan' }), params());
    expect(response.status).toBe(404);
  });

  it('PUT refuses an instance backed by another CLI tool', async () => {
    const response = await PUT(putRequest({ instanceId: 'claude', agent: 'plan' }), params());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('not an opencode instance');
  });

  it('PUT requires an instanceId', async () => {
    expect((await PUT(putRequest({ agent: 'plan' }), params())).status).toBe(400);
  });

  it('answers 404 for a worktree that does not exist', async () => {
    const response = await GET(
      new Request('http://localhost:3000/api/worktrees/nope/instances/opencode') as unknown as NextRequest,
      { params: Promise.resolve({ id: 'nope' }) }
    );
    expect(response.status).toBe(404);
  });
});
