/**
 * Issue #4290, item 1: a send that asks for a role must check the pane's launch cwd
 * before it goes on, the way the start (`base.ts`) does. With a relative
 * `XDG_CONFIG_HOME` (or a relative `HOME` and no XDG) an existing pane that was
 * `cd`'d away from the worktree reads other settings than the worktree would.
 *
 * `roleLaunchCwdReaderForPane` returns undefined under test, so it is mocked
 * explicitly here: without that, a missing wiring cannot be seen.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const cwdReaderFactory = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent-roles/pane-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-roles/pane-env')>();
  return { ...actual, roleLaunchCwdReaderForPane: cwdReaderFactory };
});

import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { createAgentRole, getInstanceRoleState } from '@/lib/db/agent-roles-db';
import { getWorktreeById } from '@/lib/db';
import { prepareSendRole } from '@/app/api/worktrees/[id]/send/send-role';
import { ROLE_LAUNCH_REFUSED_CODE } from '@/lib/agent-roles/launch-errors';
import { resetLaunchRoleStateForTest, setLaunchRoleDatabaseForTest } from '@/lib/session/role-launch';

const WT = 'wt-send-cwd-4290';
const INSTANCE = 'opencode-v2-2';

let dir: string;
let worktreePath: string;
let elsewhere: string;
let db: Database.Database;
let roleId: string;
let refused: string[];

function prepare(body: Record<string, unknown>) {
  const worktree = getWorktreeById(db, WT);
  if (!worktree) throw new Error('no worktree');
  return prepareSendRole(
    db,
    body,
    { worktree, cliToolId: 'opencode-v2', rosterInstanceId: INSTANCE, instanceId: INSTANCE },
    ((reason: string) => refused.push(reason)) as never
  );
}

const withRole = (): Record<string, unknown> => ({ role: { state: 'role', roleId } });

async function refusal(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prepared = await prepare(body);
  if (prepared.ok) throw new Error('expected a refusal');
  const response = await prepared.response;
  expect(response.status).toBe(409);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-cwd-4290-'));
  worktreePath = path.join(dir, 'wt');
  elsewhere = path.join(dir, 'elsewhere');
  fs.mkdirSync(worktreePath);
  fs.mkdirSync(elsewhere);
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, selected_agents) VALUES (?, ?, ?, ?, 'repo', ?)`
  ).run(WT, WT, worktreePath, root, JSON.stringify(['opencode-v2']));
  createRepository(db, { name: 'repo', path: root, cliSource: undefined, cloneSource: 'local' } as never);
  addAgentInstance(db, WT, { id: INSTANCE, cliTool: 'opencode-v2', alias: '', order: 1 } as never);
  roleId = createAgentRole(db, { name: 'A', body: 'BODY A' }).id;
  setLaunchRoleDatabaseForTest(db);
  refused = [];
  cwdReaderFactory.mockReset();
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', 'rel-config');
  vi.stubEnv('HOME', path.join(dir, 'home'));
});

afterEach(() => {
  resetLaunchRoleStateForTest();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('prepareSendRole: the pane launch cwd (#4290)', () => {
  it('asks for the reader of this very worktree, tool and instance', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(null));
    await prepare(withRole());
    expect(cwdReaderFactory).toHaveBeenCalledWith({ worktreeId: WT, cliToolId: 'opencode-v2', instanceId: INSTANCE });
  });

  it('relative XDG_CONFIG_HOME and a pane in another directory: refused, role saved, nothing started', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(elsewhere));
    const answer = await refusal(withRole());
    expect(answer).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'composition-failed' });
    expect(answer.roleSettings).toMatchObject({ saved: true });
    expect(getInstanceRoleState(db, WT, INSTANCE)).toMatchObject({ state: 'role', roleId });
    expect(refused).toEqual(['role-launch-refused']);
  });

  it('relative HOME with XDG_CONFIG_HOME unset: likewise', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('HOME', 'rel-home');
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(elsewhere));
    const answer = await refusal(withRole());
    expect(answer).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'composition-failed' });
    expect(answer.roleSettings).toMatchObject({ saved: true });
  });

  it('a cwd that cannot be read: refused', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.reject(new Error('tmux failed')));
    const answer = await refusal(withRole());
    expect(answer).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'composition-failed' });
  });

  it('a pane that does not exist yet (null) goes on', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(null));
    expect((await prepare(withRole())).ok).toBe(true);
  });

  it('a pane in the worktree itself goes on', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(worktreePath));
    expect((await prepare(withRole())).ok).toBe(true);
  });

  it('an absolute XDG_CONFIG_HOME goes on whatever the pane cwd is', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'abs-config'));
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(elsewhere));
    expect((await prepare(withRole())).ok).toBe(true);
  });

  it('a send without a role is not asked about the cwd', async () => {
    cwdReaderFactory.mockReturnValue(() => Promise.resolve(elsewhere));
    await expect(prepare({})).resolves.toEqual({ ok: true, value: null });
    expect((await prepare({ role: { state: 'none' } })).ok).toBe(true);
  });
});
