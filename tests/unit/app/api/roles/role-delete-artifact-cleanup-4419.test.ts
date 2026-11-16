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
import {
  buildArtifactName,
  deriveServerNamespace,
  resolveArtifactLocation,
  ROLE_ARTIFACT_PREPARED_HOLD_MS,
  writeRoleArtifact,
} from '@/lib/agent-roles/artifacts';

let testDb: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => testDb }));

/**
 * tmux is answered at `execFile`, so the route's real liveness check runs
 * (`probeSession`, Issue #3329): what `tmux has-session` does decides.
 */
type TmuxAnswer = 'present' | 'absent' | 'timeout' | 'spawn-failed';
const tmux = vi.hoisted(() => ({ answer: 'absent' as TmuxAnswer, asked: [] as string[] }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = (file: string, args: readonly string[], ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (error: unknown, result?: { stdout: string; stderr: string }) => void;
    if (file !== 'tmux' || args[0] !== 'has-session') return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, ...rest);
    tmux.asked.push(String(args[2]));
    const fail = (fields: Record<string, unknown>) => callback(Object.assign(new Error('tmux'), fields));
    if (tmux.answer === 'present') callback(null, { stdout: '', stderr: '' });
    else if (tmux.answer === 'absent') fail({ code: 1, killed: false });
    else if (tmux.answer === 'timeout') fail({ code: null, killed: true, signal: 'SIGTERM' });
    else fail({ code: 'ENOENT' });
    return undefined;
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) => `mcbd-${cliToolId}-${worktreeId}-${instanceId}`,
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
    vi.useFakeTimers({ toFake: ['Date'] });
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
    tmux.answer = 'absent';
    tmux.asked = [];
  });

  afterEach(() => {
    testDb.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    // Past the hold the launch's preparation put on the file.
    vi.setSystemTime(Date.now() + ROLE_ARTIFACT_PREPARED_HOLD_MS + 1000);
    return { id, path: artifact.path };
  }

  const remove = (id: string) => roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });

  it('removes the definition and answers as before (positive control)', async () => {
    const { id, path } = launchedRole();
    const response = await roleRoute.DELETE(request(`/api/roles/${id}`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['affected', 'deleted', 'success']);
    expect(existsSync(dirname(path))).toBe(false);
    expect(tmux.asked).toEqual([`=mcbd-antigravity-${WT}-antigravity:`]);
  });

  it.each(['timeout', 'spawn-failed'] as const)(
    'leaves it when tmux gives no answer (%s), and still deletes the role (review P1)',
    async (answer) => {
      const { id, path } = launchedRole();
      tmux.answer = answer;
      const response = await remove(id);
      expect(response.status).toBe(200);
      expect(tmux.asked).toHaveLength(1);
      expect(existsSync(path)).toBe(true);
      expect(testDb.prepare('SELECT 1 FROM agent_roles WHERE id = ?').get(id)).toBeUndefined();
    }
  );

  it('logs a directory left behind after agent.md went (review P3-2)', async () => {
    const { id, path } = launchedRole();
    const agents = dirname(dirname(path));
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    chmodSync(agents, 0o500);
    try {
      expect((await remove(id)).status).toBe(200);
    } finally {
      chmodSync(agents, 0o700);
    }
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(true);
    const logged = lines.join('\n');
    expect(logged).toContain('role-artifact-left');
    expect(logged).toContain('directory-left:EACCES');
    expect(logged).not.toContain('be a reviewer');
  });

  it('leaves it while the session runs on it, and still deletes the role', async () => {
    const { id, path } = launchedRole();
    tmux.answer = 'present';
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
