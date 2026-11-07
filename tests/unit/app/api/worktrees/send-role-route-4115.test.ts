/**
 * Issue #4115: `POST /send` and `POST /tasks` with a role, through the routes.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { createAgentRole, getInstanceRoleState, listAgentRoles, setSystemRoleDefault } from '@/lib/db/agent-roles-db';
import { resetSessionLaunchFlightsForTest, runSessionLaunch } from '@/lib/session/session-launch-flight';
import {
  getLaunchRoleEvidence,
  resetLaunchRoleStateForTest,
  noteLaunchResumedConversation,
  resolveLaunchRole,
  runWithLaunchRole,
  setLaunchRoleDatabaseForTest,
} from '@/lib/session/role-launch';
import { beginAgentSession, buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import {
  getRememberedOpencodeSession,
  rememberOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';
import { RoleLaunchRefusedError } from '@/lib/agent-roles/launch-errors';
import type { Worktree } from '@/types/models';

/** What `list-sessions` answers; null when it cannot. */
const tmuxSessions = vi.hoisted(() => ({ names: [] as string[] | null }));
vi.mock('@/lib/verification/env-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/verification/env-snapshot')>()),
  probeTmuxSessions: vi.fn(async () =>
    tmuxSessions.names === null
      ? { status: 'unavailable', entries: [], reason: 'tmux is gone' }
      : { status: 'ok', entries: tmuxSessions.names.map((key) => ({ key, detail: null, anchor: null })), reason: null }
  ),
}));
const startSession = vi.fn();
const isRunning = vi.fn(async () => false);

vi.mock('@/lib/cli-tools/codex', () => ({
  CodexTool: class {
    id = 'codex';
    name = 'Codex CLI';
    command = 'codex';
    async isInstalled() { return true; }
    async isRunning() { return isRunning(); }
    async startSession(...args: unknown[]) { return startSession(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-codex-${id}`; }
  },
}));
const opencodeStart = vi.fn();
const opencodeRunning = vi.fn(async () => false);
vi.mock('@/lib/cli-tools/opencode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/opencode')>()),
  OpenCodeTool: class {
    id = 'opencode';
    name = 'OpenCode';
    command = 'opencode';
    async isInstalled() { return true; }
    async isRunning() { return opencodeRunning(); }
    async startSession(...args: unknown[]) { return opencodeStart(...args); }
    async sendMessage() {}
    async killSession() {}
    getSessionName(id: string) { return `mcbd-opencode-${id}`; }
  },
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'absent' })),
}));
vi.mock('@/app/api/worktrees/[id]/send/pane-shell', () => ({ isPaneBackAtShell: vi.fn(async () => false) }));
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => {
  const holder: { db: Database.Database | null } = { db: null };
  return {
    getDbInstance: () => {
      if (!holder.db) throw new Error('Mock database not initialized');
      return holder.db;
    },
    setMockDb: (db: Database.Database | null) => {
      holder.db = db;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { POST as createTask } from '@/app/api/worktrees/[id]/tasks/route';

const CONTRACT = `version: 1
title: t
goal: |
  Do the work.
scope:
  allow: ["src/**"]
`;
const WT = 'wt-4115-route';
const target = { worktreeId: WT, cliToolId: 'codex' as const };

let dir: string;
let worktreePath: string;
let db: Database.Database;
let role: string;
let other: string;

function post(route: typeof sendMessage | typeof createTask, url: string, body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return route(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) }) as unknown as Promise<Response>;
}

const send = (extra: Record<string, unknown> = {}) => post(sendMessage, 'send', { content: 'hello', cliToolId: 'codex', ...extra });

/** A real launch's effect on what is known, without tmux. */
async function launchProcess(): Promise<void> {
  const snapshot = await resolveLaunchRole(db, {
    worktreeId: WT,
    cliToolId: 'codex',
    worktreePath,
    readEnv: fixedEnvReader({}),
  });
  await runWithLaunchRole(snapshot, async () => {
    beginAgentSession(target);
    buildAgentLaunchCommandLine({ target, executablePath: 'codex', worktreePath });
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-role-route-4115-'));
  worktreePath = path.join(dir, 'wt');
  fs.mkdirSync(path.join(worktreePath, '.commandmate', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.commandmate', 'tasks', 'x.yaml'), CONTRACT);
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (db: Database.Database | null) => void };
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'Role',
    path: worktreePath,
    repositoryPath: path.join(dir, 'root'),
    repositoryName: 'repo',
    cliToolId: 'codex',
  } as Worktree);
  db.prepare('UPDATE worktrees SET selected_agents = ? WHERE id = ?').run(JSON.stringify(['codex', 'claude']), WT);
  fs.mkdirSync(path.join(dir, 'root'));
  createRepository(db, { name: 'repo', path: path.join(dir, 'root'), cloneSource: 'local' });
  role = createAgentRole(db, { name: 'A', body: 'BODY A' }).id;
  other = createAgentRole(db, { name: 'B', body: 'BODY B' }).id;
  setLaunchRoleDatabaseForTest(db);
  vi.clearAllMocks();
  resetSessionLaunchFlightsForTest();
  tmuxSessions.names = [];
  isRunning.mockResolvedValue(false);
  opencodeRunning.mockResolvedValue(false);
  opencodeStart.mockReset();
  startSession.mockReset();
  startSession.mockImplementation(async () => launchProcess());
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1', content: 'hello' } });
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('CM_OPENCODE_SESSION_FILE', path.join(dir, 'opencode-sessions.json'));
  fs.mkdirSync(path.join(dir, 'codex'));
});

afterEach(async () => {
  resetLaunchRoleStateForTest();
  resetSessionLaunchFlightsForTest();
  resetOpencodeSessionMemories();
  vi.unstubAllEnvs();
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (db: Database.Database | null) => void };
  setMockDb(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /send', () => {
  it('saying nothing about a role: no boundary and an answer as before', async () => {
    const response = await send();
    expect(response.status).toBe(201);
    expect(sendUserMessage.mock.calls[0][1].inputBoundary).toBeUndefined();
    expect(Object.keys(await response.json()).sort()).toEqual(['content', 'id']);
  });

  it('`role` saves, starts with it, conditions the body and says which generation', async () => {
    const response = await send({ role: { state: 'role', roleId: role } });
    expect(response.status).toBe(201);
    expect(getInstanceRoleState(db, WT, 'codex')).toMatchObject({ state: 'role', roleId: role });
    expect(startSession).toHaveBeenCalledOnce();
    expect(sendUserMessage.mock.calls[0][1].inputBoundary).toBeDefined();
    const answer = await response.json();
    expect(answer.roleLaunch.saved).toBe(true);
    expect(answer.roleLaunch.sessionGeneration).toBe(getLaunchRoleEvidence(target)?.sessionGeneration);
    expect(answer.roleLaunch.injectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the boundary it passes stops a change made after the check', async () => {
    await send({ role: { state: 'inherit' } });
    const boundary = sendUserMessage.mock.calls[0][1].inputBoundary;
    expect(() => boundary.beforeInput(new Date(), 'input_start')).not.toThrow();
    setSystemRoleDefault(db, 'codex', other);
    expect(() => boundary.beforeInput(new Date(), 'input_start')).toThrow(/role/i);
  });

  it('a running process with another role: not sent, with a stable code, and the setting saved', async () => {
    setSystemRoleDefault(db, 'codex', other);
    await launchProcess();
    isRunning.mockResolvedValue(true);
    const response = await send({ role: { state: 'role', roleId: role } });
    expect(response.status).toBe(409);
    const answer = await response.json();
    expect(answer).toMatchObject({
      code: 'ROLE_CONDITION_UNMET',
      sendOutcome: 'not_sent',
      roleSettings: { saved: true, stored: { state: 'role', roleId: role } },
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('`--no-role` on a process with a role is refused the same way', async () => {
    setSystemRoleDefault(db, 'codex', other);
    await launchProcess();
    isRunning.mockResolvedValue(true);
    const response = await send({ role: { state: 'none' } });
    expect((await response.json()).code).toBe('ROLE_CONDITION_UNMET');
  });

  it('a running process with no evidence: not sent', async () => {
    isRunning.mockResolvedValue(true);
    const response = await send({ role: { state: 'role', roleId: role } });
    expect(await response.json()).toMatchObject({ code: 'ROLE_CONDITION_UNMET', sendOutcome: 'not_sent' });
  });

  it('a start refused because of its role: nothing sent, sendOutcome not_sent', async () => {
    startSession.mockRejectedValue(new RoleLaunchRefusedError('artifact-failed', 'cannot write'));
    const response = await send();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'ROLE_LAUNCH_REFUSED',
      roleRefusal: 'artifact-failed',
      sendOutcome: 'not_sent',
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('an unknown role: refused before anything, and nothing saved', async () => {
    const response = await send({ role: { state: 'role', roleId: 'nope' } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ sendOutcome: 'not_sent', roleSettings: { saved: false } });
    expect(startSession).not.toHaveBeenCalled();
    expect(listAgentRoles(db)).toHaveLength(2);
  });
});

describe('POST /send to OpenCode V1, continuing a conversation', () => {
  const opencode = { worktreeId: WT, cliToolId: 'opencode' as const };
  const sendV1 = (extra: Record<string, unknown> = {}) => post(sendMessage, 'send', { content: 'hello', cliToolId: 'opencode', ...extra });

  it('a default moved by inheritance, with nothing named: the answer says the conversation goes on', async () => {
    const launchV1 = async (): Promise<void> => {
      const snapshot = await resolveLaunchRole(db, { ...opencode, worktreePath, readEnv: fixedEnvReader({}) });
      await runWithLaunchRole(snapshot, async () => {
        beginAgentSession(opencode);
        buildAgentLaunchCommandLine({ target: opencode, executablePath: 'opencode', worktreePath });
        noteLaunchResumedConversation(opencode);
      });
    };
    setSystemRoleDefault(db, 'opencode', role);
    await launchV1();
    setSystemRoleDefault(db, 'opencode', other);
    opencodeStart.mockImplementation(launchV1);

    const first = await (await sendV1()).json();
    expect(first.roleResume).toMatchObject({ continued: true, newConversationField: 'newConversation' });
    expect(first.roleLaunch).toBeUndefined();

    // Once per process.
    expect((await (await sendV1()).json()).roleResume).toBeUndefined();
  });

  it('a relaunch inside the send is told as well, in that send\'s answer', async () => {
    setSystemRoleDefault(db, 'opencode', role);
    const launchV1 = async (): Promise<void> => {
      const snapshot = await resolveLaunchRole(db, { ...opencode, worktreePath, readEnv: fixedEnvReader({}) });
      await runWithLaunchRole(snapshot, async () => {
        beginAgentSession(opencode);
        buildAgentLaunchCommandLine({ target: opencode, executablePath: 'opencode', worktreePath });
        noteLaunchResumedConversation(opencode);
      });
    };
    await launchV1();
    setSystemRoleDefault(db, 'opencode', other);
    opencodeRunning.mockResolvedValue(true);
    sendUserMessage.mockImplementation(async () => {
      await launchV1();
      return { ok: true, message: { id: 'm2', content: 'hello' } };
    });
    expect((await (await sendV1()).json()).roleResume?.continued).toBe(true);
  });

  it('`newConversation` drops the remembered id before the start', async () => {
    rememberOpencodeSession(opencode, { sessionId: 'ses_0123456789abcdefghijklmnop', worktreePath });
    expect((await sendV1({ newConversation: true })).status).toBe(201);
    expect(getRememberedOpencodeSession(opencode)).toBeNull();
  });

  it('without it the id stays, and to a running process the choice does nothing', async () => {
    rememberOpencodeSession(opencode, { sessionId: 'ses_0123456789abcdefghijklmnop', worktreePath });
    await sendV1();
    expect(getRememberedOpencodeSession(opencode)).not.toBeNull();
    opencodeRunning.mockResolvedValue(true);
    await sendV1({ newConversation: true });
    expect(getRememberedOpencodeSession(opencode)).not.toBeNull();
  });
});

describe('POST /tasks: a contract goes out under the role of the start', () => {
  const contract = () => post(createTask, 'tasks', { contractPath: '.commandmate/tasks/x.yaml', cliToolId: 'codex' });

  it('nothing started: it is created, and the send that follows starts under the latest', async () => {
    setSystemRoleDefault(db, 'codex', role);
    expect((await contract()).status).toBe(201);
  });

  it('started and unchanged: created', async () => {
    setSystemRoleDefault(db, 'codex', role);
    await launchProcess();
    expect((await contract()).status).toBe(201);
  });

  it('the default changed since the start: refused, and no task', async () => {
    setSystemRoleDefault(db, 'codex', role);
    await launchProcess();
    setSystemRoleDefault(db, 'codex', other);
    const response = await contract();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'ROLE_CONDITION_UNMET', sendOutcome: 'not_sent' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  describe('[#4132] a running session with no evidence is warned about, not refused', () => {
    const SESSION = `mcbd-codex-${WT}`;
    const created = async (): Promise<Record<string, unknown>> => {
      const response = await contract();
      expect(response.status).toBe(201);
      return response.json();
    };

    it('a role resolves: created, with a warning that says what to do', async () => {
      setSystemRoleDefault(db, 'codex', role);
      tmuxSessions.names = [SESSION];
      const answer = await created();
      expect(answer.roleWarning).toMatch(/--role/);
      expect(answer.roleWarning).toMatch(/--expect-/);
      expect(answer.roleWarning).toMatch(/stop the session/i);
      expect(String(answer.roleWarning)).not.toContain('\n');
      expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    });

    it('no role resolves: the answer is as before', async () => {
      tmuxSessions.names = [SESSION];
      expect(Object.keys(await created()).sort()).toEqual(['message', 'task']);
    });

    it('another session runs, not this one: the answer is as before', async () => {
      setSystemRoleDefault(db, 'codex', role);
      tmuxSessions.names = [`${SESSION}-2`];
      expect(Object.keys(await created()).sort()).toEqual(['message', 'task']);
    });

    it('being started: the answer is as before', async () => {
      setSystemRoleDefault(db, 'codex', role);
      tmuxSessions.names = [SESSION];
      let finish = (): void => {};
      const launch = runSessionLaunch(SESSION, 'Codex CLI', () => new Promise<void>((resolve) => { finish = resolve; }));
      expect(Object.keys(await created()).sort()).toEqual(['message', 'task']);
      finish();
      await launch;
    });

    it('started by this server: the answer is as before', async () => {
      setSystemRoleDefault(db, 'codex', role);
      await launchProcess();
      tmuxSessions.names = [SESSION];
      expect(Object.keys(await created()).sort()).toEqual(['message', 'task']);
    });

    it('whether it runs cannot be told: created all the same, with no warning', async () => {
      setSystemRoleDefault(db, 'codex', role);
      tmuxSessions.names = null;
      expect(Object.keys(await created()).sort()).toEqual(['message', 'task']);
    });
  });
});
