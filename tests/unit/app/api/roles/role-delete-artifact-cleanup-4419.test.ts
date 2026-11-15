/**
 * `DELETE /api/roles/:id` removes the role's Antigravity definitions (Issue #4419),
 * and a cleanup that cannot finish never fails the delete.
 *
 * HOME is a private temporary directory: the real `~/.gemini` is never touched.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createAgentRole, recordRoleLaunch } from '@/lib/db/agent-roles-db';
import { buildArtifactName, deriveServerNamespace, resolveArtifactLocation, writeRoleArtifact } from '@/lib/agent-roles/artifacts';

let testDb: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => testDb }));

const running = vi.hoisted(() => ({ value: false, asked: [] as string[] }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        isRunning: async (worktreeId: string, instanceId?: string) => {
          running.asked.push(`${cliToolId}:${worktreeId}:${instanceId}`);
          return running.value;
        },
      }),
    }),
  },
}));

import * as roleRoute from '@/app/api/roles/[id]/route';

const WT = 'wt-4419-route';

function request(url: string): NextRequest {
  const req = new Request(`http://localhost:3000${url}`, { method: 'DELETE' }) as unknown as NextRequest;
  Object.defineProperty(req, 'nextUrl', { value: new URL(`http://localhost:3000${url}`) });
  return req;
}

describe('DELETE /api/roles/:id cleans up the Antigravity definition (Issue #4419)', () => {
  let base: string;
  let home: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cm-role-route-4419-')));
    home = join(base, 'home');
    mkdirSync(home, { mode: 0o700 });
    vi.stubEnv('HOME', home);
    vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', '');
    vi.stubEnv('CM_UAT_ISOLATION', '');
    expect(homedir()).toBe(home);
    if (!resolveArtifactLocation('antigravity', 'cm-role-probe').path.startsWith(`${home}${sep}`)) {
      throw new Error('HOME is not pinned; refusing to run');
    }
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb
      .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`)
      .run(WT, WT, join(base, 'wt'), join(base, 'repo'));
    running.value = false;
    running.asked = [];
  });

  afterEach(() => {
    testDb.close();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  function launchedRole(): { id: string; path: string } {
    const id = createAgentRole(testDb, { name: 'Reviewer', body: 'be a reviewer' }).id;
    const name = buildArtifactName({
      namespace: deriveServerNamespace(testDb.name),
      roleId: id,
      injectionFingerprint: 'c'.repeat(64),
    });
    const artifact = writeRoleArtifact({ adapter: 'antigravity', name, instructions: 'be a reviewer' });
    recordRoleLaunch(testDb, {
      worktreeId: WT,
      instanceId: 'antigravity',
      cliToolId: 'antigravity',
      phase: 'launched',
      sessionGeneration: 'g1',
      source: 'instance',
      repositoryId: null,
      roleId: id,
      roleName: 'Reviewer',
      bodyVersion: 1,
      bodyFingerprint: 'b'.repeat(64),
      injectionFingerprint: 'c'.repeat(64),
      artifactFingerprint: artifact.artifactFingerprint,
      adapterId: 'antigravity',
      adapterVersion: null,
      wrapperVersion: null,
      artifactPath: artifact.path,
      effectiveAgent: name,
      compositionSourceFingerprint: null,
      noRoleReason: null,
    });
    return { id, path: artifact.path };
  }

  it('removes the definition and answers as before (positive control)', async () => {
    const { id, path } = launchedRole();
    const response = await roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['affected', 'deleted', 'success']);
    expect(existsSync(dirname(path))).toBe(false);
    expect(running.asked).toEqual([`antigravity:${WT}:antigravity`]);
  });

  it('leaves it while the session runs on it, and still deletes the role', async () => {
    const { id, path } = launchedRole();
    running.value = true;
    const response = await roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(existsSync(path)).toBe(true);
    expect(testDb.prepare('SELECT 1 FROM agent_roles WHERE id = ?').get(id)).toBeUndefined();
  });

  it('a cleanup the filesystem refuses still deletes the role', async () => {
    const { id, path } = launchedRole();
    chmodSync(dirname(path), 0o500);
    try {
      const response = await roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200);
      expect(existsSync(path)).toBe(true);
      expect(testDb.prepare('SELECT 1 FROM agent_roles WHERE id = ?').get(id)).toBeUndefined();
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  it('a role in use without force is still refused, and nothing is removed (negative control)', async () => {
    const { id, path } = launchedRole();
    testDb
      .prepare(`INSERT INTO agent_role_system_defaults (cli_tool_id, role_id, updated_at) VALUES ('antigravity', ?, 0)`)
      .run(id);
    const response = await roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(409);
    expect(existsSync(path)).toBe(true);
  });
});
