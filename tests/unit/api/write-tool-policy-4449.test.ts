/**
 * Issue #4449: the writes a send makes before its message refuse that send themselves.
 * `POST /instances/roles` (`send --register --role`), `PUT /instances/roles`
 * (`send --contract --role`) and `POST /tasks` (`send --contract`) take the body's
 * `origin` and `replyTo`, ask the tool policy in the same request, and answer the send's
 * 409 (`TOOL_POLICY_DENIED`, or the relay's `RELAY_TOOL_POLICY_DENIED`) with NO row in
 * agent_instances, agent_instance_roles or tasks (I1). Without an origin (the web UI, an
 * older CLI), with a declaration, or for another tool, they write as before (I6).
 *
 * In-memory database, a worktree under os.tmpdir() (removed after each test), no agy.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { createAgentRole } from '@/lib/db/agent-roles-db';
import {
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_URL,
  RELAY_TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED,
  TOOL_POLICY_DENIED_MESSAGE,
} from '@/lib/tool-policy/policy';
import type { Worktree } from '@/types/models';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** Runs while `POST /tasks` awaits its role warning — between its verdict and its write. */
const duringTaskRead = vi.hoisted(() => ({ hook: null as null | (() => void) }));
vi.mock('@/app/api/worktrees/[id]/tasks/contract-role-warning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/worktrees/[id]/tasks/contract-role-warning')>();
  return {
    ...actual,
    contractRoleWarning: async (...args: Parameters<typeof actual.contractRoleWarning>) => {
      duringTaskRead.hook?.();
      return actual.contractRoleWarning(...args);
    },
  };
});

import * as instanceRolesRoute from '@/app/api/worktrees/[id]/instances/roles/route';
import * as tasksRoute from '@/app/api/worktrees/[id]/tasks/route';

const WT = 'wt-4449-write';
const CONTRACT = 'version: 1\ntitle: t\ngoal: |\n  Do the work.\nscope:\n  allow: ["src/**"]\n';

let dir: string;
let roleId: string;

type Handler = (request: NextRequest, context: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(
  handler: Handler,
  route: string,
  method: 'POST' | 'PUT',
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handler(request, { params: Promise.resolve({ id: WT }) });
  return { status: response.status, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
/** The three tables a send writes before its message (I1). */
const writtenRows = (): Record<string, number> => ({
  agent_instances: count('agent_instances'),
  agent_instance_roles: count('agent_instance_roles'),
  tasks: count('tasks'),
});

const registerBody = (cliTool: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  instance: { id: 'agy-new', cliTool, alias: 'New' },
  role: { state: 'role', roleId },
  ...extra,
});

function expectSendRefusal(body: Record<string, unknown>, origin: string): void {
  expect(body).toEqual({
    error: TOOL_POLICY_DENIED_MESSAGE,
    code: TOOL_POLICY_DENIED,
    sendOutcome: 'not_sent',
    policy: expect.objectContaining({
      tool: 'antigravity',
      operation: 'send',
      origin,
      links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
    }),
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-write-tool-policy-4449-')));
  const worktreePath = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'), CONTRACT);
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt',
    path: worktreePath,
    repositoryPath: path.join(dir, 'root'),
    repositoryName: 'repo',
    cliToolId: 'codex',
  } as Worktree);
  roleId = createAgentRole(db, { name: 'reviewer', body: 'REVIEW' }).id;
  vi.stubEnv('CM_ANTIGRAVITY_USAGE', '');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
});

afterEach(() => {
  duringTaskRead.hook = null;
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /instances/roles — send --register --role (Issue #4449)', () => {
  it.each(['session', 'agent', 'schedule', 'unknown'])('4449: antigravity from %s is refused with the send\'s 409 and no row', async (origin) => {
    const { status, body } = await call(instanceRolesRoute.POST as Handler, 'instances/roles', 'POST', registerBody('antigravity', { origin, originEvidence: 'x' }));
    expect(status).toBe(409);
    expectSendRefusal(body, origin);
    expect(writtenRows()).toEqual({ agent_instances: 0, agent_instance_roles: 0, tasks: 0 });
  });

  it('4449: a relay with antigravity at its other end is refused with the relay\'s 409 and no row', async () => {
    const { status, body } = await call(
      instanceRolesRoute.POST as Handler,
      'instances/roles',
      'POST',
      { ...registerBody('codex', { origin: 'session' }), instance: { id: 'codex-new', cliTool: 'codex', alias: 'C' }, replyTo: { worktreeId: WT, instanceId: 'antigravity' } },
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: RELAY_TOOL_POLICY_DENIED, policy: { tool: 'antigravity', endpoint: 'from' } });
    expect(writtenRows()).toEqual({ agent_instances: 0, agent_instance_roles: 0, tasks: 0 });
  });

  it.each([
    ['no origin (the web UI, an older CLI)', {}],
    ['a person in a terminal', { origin: 'terminal' }],
  ])('4449 control — %s: created as before', async (_label, extra) => {
    const { status, body } = await call(instanceRolesRoute.POST as Handler, 'instances/roles', 'POST', registerBody('antigravity', extra));
    expect(status).toBe(201);
    expect(body.created).toEqual({ instanceId: 'agy-new' });
    expect(count('agent_instance_roles')).toBe(1);
  });

  it('4449 control — a declared server creates it from a session', async () => {
    vi.stubEnv('CM_ANTIGRAVITY_USAGE', 'api-key');
    const { status } = await call(instanceRolesRoute.POST as Handler, 'instances/roles', 'POST', registerBody('antigravity', { origin: 'session' }));
    expect(status).toBe(201);
  });

  it('4449 control — codex from a session is created as before', async () => {
    const { status } = await call(
      instanceRolesRoute.POST as Handler,
      'instances/roles',
      'POST',
      { ...registerBody('codex', { origin: 'session' }), instance: { id: 'codex-new', cliTool: 'codex', alias: 'C' } },
    );
    expect(status).toBe(201);
  });

  it('4449: an origin that is not a string is a 400 and writes nothing', async () => {
    const { status } = await call(instanceRolesRoute.POST as Handler, 'instances/roles', 'POST', registerBody('antigravity', { origin: 3 }));
    expect(status).toBe(400);
    expect(writtenRows()).toEqual({ agent_instances: 0, agent_instance_roles: 0, tasks: 0 });
  });
});

describe('PUT /instances/roles — send --contract --role (Issue #4449)', () => {
  beforeEach(() => {
    setAgentInstances(db, WT, [
      { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 },
      { id: 'agy-1', cliTool: 'antigravity', alias: 'Agy', order: 1 },
    ] as Parameters<typeof setAgentInstances>[2]);
  });

  it('4449: antigravity\'s role is not saved for a send from a session (409, no row)', async () => {
    const { status, body } = await call(instanceRolesRoute.PUT as Handler, 'instances/roles', 'PUT', {
      instanceId: 'agy-1',
      role: { state: 'role', roleId },
      origin: 'session',
    });
    expect(status).toBe(409);
    expectSendRefusal(body, 'session');
    expect(count('agent_instance_roles')).toBe(0);
  });

  it('4449 control — without an origin (the web UI, `instances set-role`) it is saved as before', async () => {
    const { status } = await call(instanceRolesRoute.PUT as Handler, 'instances/roles', 'PUT', {
      instanceId: 'agy-1',
      role: { state: 'role', roleId },
    });
    expect(status).toBe(200);
    expect(count('agent_instance_roles')).toBe(1);
  });

  it('4449 control — codex\'s role from a session is saved as before', async () => {
    const { status } = await call(instanceRolesRoute.PUT as Handler, 'instances/roles', 'PUT', {
      instanceId: 'codex',
      role: { state: 'role', roleId },
      origin: 'session',
    });
    expect(status).toBe(200);
    expect(count('agent_instance_roles')).toBe(1);
  });
});

describe('POST /tasks — send --contract (Issue #4449)', () => {
  const contract = { contractPath: '.commandmate/tasks/x.yaml' };

  it('4449: antigravity from a session: 409, no task row', async () => {
    const { status, body } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', {
      ...contract,
      cliToolId: 'antigravity',
      instanceId: 'antigravity',
      origin: 'session',
    });
    expect(status).toBe(409);
    expectSendRefusal(body, 'session');
    expect(writtenRows()).toEqual({ agent_instances: 0, agent_instance_roles: 0, tasks: 0 });
  });

  it('4449: naming no target, the default (antigravity) is what is judged — 409, no task row', async () => {
    db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('antigravity', WT);
    const { status, body } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', { ...contract, origin: 'unknown' });
    expect(status).toBe(409);
    expectSendRefusal(body, 'unknown');
    expect(count('tasks')).toBe(0);
  });

  it('4449: the relay of --reply-to with antigravity at its other end: the relay\'s 409, no task row', async () => {
    const { status, body } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', {
      ...contract,
      cliToolId: 'codex',
      instanceId: 'codex',
      replyTo: { worktreeId: WT, instanceId: 'antigravity' },
    });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: RELAY_TOOL_POLICY_DENIED, policy: { tool: 'antigravity', endpoint: 'from' } });
    expect(count('tasks')).toBe(0);
  });

  it('4449 (I2): naming no target, the row is written for the default that was judged', async () => {
    const { status, body } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', { ...contract, origin: 'session' });
    expect(status).toBe(201);
    expect(body.task).toMatchObject({ cliToolId: 'codex', instanceId: null });
  });

  it('4449 (I2): a default turned antigravity while the request awaits is not resolved again — the row names the target judged', async () => {
    duringTaskRead.hook = () => {
      db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('antigravity', WT);
    };
    const { status, body } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', { ...contract, origin: 'session' });
    expect(status).toBe(201);
    expect(body.task).toMatchObject({ cliToolId: 'codex' });
    // The default did turn in between (the hook ran), and the row did not follow it.
    expect((db.prepare('SELECT cli_tool_id AS tool FROM worktrees WHERE id = ?').get(WT) as { tool: string }).tool).toBe('antigravity');
    expect((db.prepare('SELECT cli_tool_id AS tool FROM tasks').all() as Array<{ tool: string }>).map((row) => row.tool)).toEqual(['codex']);
  });

  it.each([
    ['no origin (an older CLI)', { cliToolId: 'antigravity', instanceId: 'antigravity' }],
    ['a person in a terminal', { cliToolId: 'antigravity', instanceId: 'antigravity', origin: 'terminal' }],
    ['codex from a session', { cliToolId: 'codex', instanceId: 'codex', origin: 'session' }],
  ])('4449 control — %s: the task is created as before', async (_label, extra) => {
    const { status } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', { ...contract, ...extra });
    expect(status).toBe(201);
    expect(count('tasks')).toBe(1);
  });

  it('4449: a malformed replyTo is a 400 and writes nothing', async () => {
    const { status } = await call(tasksRoute.POST as Handler, 'tasks', 'POST', { ...contract, replyTo: { worktreeId: WT } });
    expect(status).toBe(400);
    expect(count('tasks')).toBe(0);
  });
});
