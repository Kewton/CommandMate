/**
 * Issue #4115: `send --role` / `--no-role` and pins, up to the first key. The moments
 * in question are the ones between a check and the input: a default changed, a body
 * edited, a process replaced.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import { createAgentRole, getInstanceRoleState, setSystemRoleDefault, updateAgentRole } from '@/lib/db/agent-roles-db';
import { getWorktreeById } from '@/lib/db';
import {
  checkRunningRole,
  chooseNewOpencodeConversation,
  prepareSendRole,
  roleConditionBoundary,
  roleSendNotices,
  takeOpencodeResumeNotice,
  type SendRoleGate,
} from '@/app/api/worktrees/[id]/send/send-role';
import { answerSessionStartFailure } from '@/app/api/worktrees/[id]/send/send-session-start';
import { answerSendFailure } from '@/app/api/worktrees/[id]/send/send-failure';
import {
  beginAgentSession,
  buildAgentLaunchCommandLine,
} from '@/lib/session/agent-session-lifecycle';
import {
  forgetLaunchRoleEvidence,
  getLaunchRoleEvidence,
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runWithLaunchRole,
  setLaunchRoleDatabaseForTest,
} from '@/lib/session/role-launch';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import {
  isRoleConditionUnmet,
  ROLE_CONDITION_UNMET_CODE,
  ROLE_LAUNCH_REFUSED_CODE,
  RoleConditionUnmetError,
  RoleLaunchRefusedError,
} from '@/lib/agent-roles/launch-errors';
import { InputBoundaryRefusedError, isInputBoundaryRefusal } from '@/lib/session/instance-input-lock';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import {
  rememberOpencodeSession,
  getRememberedOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';
import { SessionLaunchRoleMismatchError } from '@/lib/session/session-launch-flight';
import type { ICLITool } from '@/lib/cli-tools/types';

const WT = 'wt-send-4115';
const target = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: undefined };
const SESSION_ID = 'ses_0123456789abcdefghijklmnop';

let dir: string;
let worktreePath: string;
let db: Database.Database;
let a: string;
let b: string;
let refused: string[];

function worktree() {
  const row = getWorktreeById(db, WT);
  if (!row) throw new Error('no worktree');
  return row;
}

const recordNotSent = (reason: string): void => {
  refused.push(reason);
};

function prepare(body: Record<string, unknown>) {
  return prepareSendRole(
    db,
    body,
    { worktree: worktree(), cliToolId: 'claude', rosterInstanceId: 'claude', instanceId: undefined },
    recordNotSent as never
  );
}

/** A launch of the primary, as a driver's would be: what it injects, under a new generation. */
async function launch(): Promise<void> {
  const snapshot = await resolveLaunchRole(db, {
    worktreeId: WT,
    cliToolId: 'claude',
    worktreePath,
    readEnv: fixedEnvReader({}),
  });
  const claudeTarget = { worktreeId: WT, cliToolId: 'claude' as const };
  await runWithLaunchRole(snapshot, async () => {
    beginAgentSession(claudeTarget);
    buildAgentLaunchCommandLine({ target: claudeTarget, executablePath: 'claude', worktreePath });
  });
}

async function gateOf(body: Record<string, unknown>): Promise<SendRoleGate> {
  const prepared = await prepare(body);
  if (!prepared.ok) throw new Error(`refused: ${JSON.stringify(await (await prepared.response).json())}`);
  if (prepared.value === null) throw new Error('no gate');
  return prepared.value;
}

async function bodyOf(response: Response | Promise<Response>): Promise<Record<string, unknown>> {
  return (await response).json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-send-role-4115-'));
  worktreePath = path.join(dir, 'wt');
  fs.mkdirSync(worktreePath);
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, selected_agents) VALUES (?, ?, ?, ?, 'repo', ?)`
  ).run(WT, WT, worktreePath, root, JSON.stringify(['claude', 'codex']));
  createRepository(db, { name: 'repo', path: root, cloneSource: 'local' });
  a = createAgentRole(db, { name: 'A', body: 'BODY A' }).id;
  b = createAgentRole(db, { name: 'B', body: 'BODY B' }).id;
  setLaunchRoleDatabaseForTest(db);
  refused = [];
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_OPENCODE_SESSION_FILE', path.join(dir, 'opencode-sessions.json'));
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'config'));
});

afterEach(() => {
  resetLaunchRoleStateForTest();
  resetOpencodeSessionMemories();
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('prepareSendRole', () => {
  it('says nothing when the request says nothing, and reads nothing', async () => {
    const target_ = { worktree: worktree(), cliToolId: 'claude' as const, rosterInstanceId: 'claude', instanceId: undefined };
    const spy = vi.spyOn(db, 'prepare');
    await expect(prepareSendRole(db, {}, target_, recordNotSent as never)).resolves.toEqual({ ok: true, value: null });
    expect(spy).not.toHaveBeenCalled();
    expect(refused).toEqual([]);
  });

  it('saves the role first, and what must be injected follows it', async () => {
    const gate = await gateOf({ role: { state: 'role', roleId: a } });
    expect(gate.saved).toBe(true);
    expect(getInstanceRoleState(db, WT, 'claude')).toMatchObject({ state: 'role', roleId: a });
    expect(gate.condition?.injectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const none = await gateOf({ role: { state: 'none' } });
    expect(none.condition?.injectionFingerprint).toBeNull();
    expect(getInstanceRoleState(db, WT, 'claude')).toEqual({ state: 'none' });
  });

  it('refuses a malformed role, an unknown role and an instance outside the roster, saving nothing', async () => {
    const malformed = await prepare({ role: { state: 'bogus' } });
    expect(malformed.ok).toBe(false);
    const unknown = await prepare({ role: { state: 'role', roleId: 'no-such-role' } });
    if (unknown.ok) throw new Error('expected a refusal');
    const answer = await bodyOf(unknown.response);
    expect(answer.code).toBe('not_found');
    expect(answer.roleSettings).toEqual({ saved: false, stored: { state: 'inherit' } });

    const adHoc = await prepareSendRole(
      db,
      { role: { state: 'role', roleId: a } },
      { worktree: worktree(), cliToolId: 'claude', rosterInstanceId: 'claude-9', instanceId: 'claude-9' },
      recordNotSent as never
    );
    expect(adHoc.ok).toBe(false);
    expect(getInstanceRoleState(db, WT, 'claude-9')).toEqual({ state: 'inherit' });
    expect(refused).toHaveLength(3);
    expect(new Set(refused)).toEqual(new Set(['role-launch-refused']));
  });

  it('refuses a role on a disabled adapter, saving nothing', async () => {
    const prepared = await prepareSendRole(
      db,
      { role: { state: 'role', roleId: a } },
      { worktree: worktree(), cliToolId: 'antigravity', rosterInstanceId: 'antigravity', instanceId: undefined },
      recordNotSent as never
    );
    if (prepared.ok) throw new Error('expected a refusal');
    const answer = await bodyOf(prepared.response);
    expect(answer).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'adapter-disabled' });
    expect(getInstanceRoleState(db, WT, 'antigravity')).toEqual({ state: 'inherit' });
  });

  it('a pin that the settings no longer answer refuses, and says what is saved', async () => {
    setSystemRoleDefault(db, 'claude', a);
    const pinned = (await gateOf({ expectedRole: { injectionFingerprint: null } }).catch(() => null)) ?? null;
    expect(pinned).toBeNull();
    expect(refused).toEqual(['role-condition-failed']);
  });

  it('a pin must carry a fingerprint', async () => {
    const prepared = await prepare({ expectedRole: { sessionGeneration: 'g' } });
    expect(prepared.ok).toBe(false);
  });
});

describe('the process about to receive the body', () => {
  it('with what was asked for: goes on, and pins the generation', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launch();
    const gate = await gateOf({ role: { state: 'role', roleId: a } });
    expect(checkRunningRole(gate, target, recordNotSent as never)).toBeNull();
    expect(gate.condition?.sessionGeneration).toBe(getLaunchRoleEvidence(target)?.sessionGeneration);
    expect(refused).toEqual([]);
  });

  it('started with another role: refused, and the setting stays saved', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launch();
    const gate = await gateOf({ role: { state: 'role', roleId: b } });
    const refusal = checkRunningRole(gate, target, recordNotSent as never);
    const answer = await bodyOf(refusal as Response);
    expect(answer.code).toBe(ROLE_CONDITION_UNMET_CODE);
    expect(answer.roleSettings).toMatchObject({ saved: true, stored: { state: 'role', roleId: b } });
    expect(refused).toEqual(['role-condition-failed']);
  });

  it('no evidence (a server restart): refused rather than assumed', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launch();
    const gate = await gateOf({ role: { state: 'role', roleId: a } });
    forgetLaunchRoleEvidence(target);
    const answer = await bodyOf(checkRunningRole(gate, target, recordNotSent as never) as Response);
    expect(answer.error).toMatch(/no record of what the running process was started with/);
  });

  it('a pinned generation that is gone: refused', async () => {
    setSystemRoleDefault(db, 'claude', a);
    await launch();
    const { injectionFingerprint } = getLaunchRoleEvidence(target) as { injectionFingerprint: string };
    const gate = await gateOf({ expectedRole: { injectionFingerprint, sessionGeneration: 'gone' } });
    const answer = await bodyOf(checkRunningRole(gate, target, recordNotSent as never) as Response);
    expect(answer.error).toMatch(/replaced since the role was pinned/);
  });
});

describe('between the check and the first key', () => {
  async function checked(): Promise<SendRoleGate> {
    setSystemRoleDefault(db, 'claude', a);
    await launch();
    const gate = await gateOf({ role: { state: 'inherit' } });
    expect(checkRunningRole(gate, target, recordNotSent as never)).toBeNull();
    return gate;
  }

  const fire = (gate: SendRoleGate, next?: { beforeInput: () => void }) => () =>
    roleConditionBoundary(gate, target, next as never)?.beforeInput(new Date(), 'input_start');

  it('nothing changed: the next hook runs, after this one', async () => {
    const gate = await checked();
    const next = { beforeInput: vi.fn() };
    fire(gate, next)();
    expect(next.beforeInput).toHaveBeenCalledOnce();
  });

  it('the default changed: stopped, and the next hook is not reached', async () => {
    const gate = await checked();
    setSystemRoleDefault(db, 'claude', b);
    const next = { beforeInput: vi.fn() };
    expect(fire(gate, next)).toThrow(RoleConditionUnmetError);
    expect(next.beforeInput).not.toHaveBeenCalled();
  });

  it('the body was edited: stopped', async () => {
    const gate = await checked();
    updateAgentRole(db, a, { body: 'BODY A edited' });
    expect(fire(gate)).toThrow(/role changed/);
  });

  it('the process ended and a driver relaunched: stopped, even with the same role', async () => {
    const gate = await checked();
    await launch();
    expect(fire(gate)).toThrow(/replaced/);
  });

  it('the process is gone: stopped', async () => {
    const gate = await checked();
    forgetLaunchRoleEvidence(target);
    expect(fire(gate)).toThrow(/replaced/);
  });

  it('a request that said nothing passes straight to what it had', () => {
    const next = { beforeInput: vi.fn() };
    expect(roleConditionBoundary(null, target, next as never)).toBe(next);
    expect(roleConditionBoundary(null, target)).toBeUndefined();
  });

  it('keeps the reason once the boundary has wrapped it, through a driver\'s wrap too', async () => {
    const boundary = new InputBoundaryRefusedError(new RoleConditionUnmetError('The role changed'));
    expect(isInputBoundaryRefusal(boundary)).toBe(true);
    expect(isRoleConditionUnmet(boundary)).toBe(true);
    expect(classifySendFailure(boundary)).toEqual({ state: 'not-sent', reason: 'role-condition-failed' });
    const wrapped = new Error(`Failed to send message to Codex: ${boundary.message}`);
    expect(classifySendFailure(wrapped)).toEqual({ state: 'not-sent', reason: 'role-condition-failed' });
  });
});

describe('the answers', () => {
  const cliTool = { name: 'Codex CLI', getSessionName: () => 'mcbd-codex-x' } as unknown as ICLITool;
  const input = { cliTool, worktreeId: WT, instanceId: undefined };

  it('a start refused for its role is a 409 with a stable code, recorded as not sent', async () => {
    const recorded: string[] = [];
    const error = new Error(`Failed to start Codex session: ${new RoleLaunchRefusedError('composition-failed', 'bad env').message}`);
    const response = await answerSessionStartFailure(error, { ...input, recordNotSent: (reason) => recorded.push(reason) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'composition-failed' });
    expect(recorded).toEqual(['role-launch-refused']);
  });

  it('a start that met another role\'s launch likewise', async () => {
    const recorded: string[] = [];
    const response = await answerSessionStartFailure(new SessionLaunchRoleMismatchError('Codex CLI', 's'), {
      ...input,
      recordNotSent: (reason) => recorded.push(reason),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SESSION_LAUNCH_ROLE_MISMATCH' });
    expect(recorded).toEqual(['role-launch-refused']);
    expect(classifySendFailure(new SessionLaunchRoleMismatchError('Codex CLI', 's')).state).toBe('not-sent');
  });

  it('a send stopped at the boundary is a 409 and not a server fault', async () => {
    const response = await answerSendFailure(
      { stage: 'send', error: 'The role changed (ROLE_CONDITION_UNMET)' },
      {
        ...input,
        model: undefined,
        sendAttemptInstance: { worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' },
        ownAttempt: { state: 'not-sent', reason: 'role-condition-failed' },
        sendStartedAt: Date.now(),
        trimmedContent: 'x',
      }
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(ROLE_CONDITION_UNMET_CODE);
  });

  it('after a send: the generation for a request that asked, and V2 says it replaces the defaults', () => {
    const evidence = { sessionGeneration: 'g', injectionFingerprint: 'f' };
    expect(roleSendNotices({ cliToolId: 'claude', gate: null, evidence, opencodeResume: null })).toEqual({});
    expect(roleSendNotices({ cliToolId: 'opencode-v2', gate: null, evidence, opencodeResume: null })).toEqual({
      replacesDefaultInstructions: true,
    });
    const gate = { condition: null, snapshot: null, saved: true, stored: { state: 'none' as const } };
    expect(roleSendNotices({ cliToolId: 'claude', gate, evidence, opencodeResume: null }).roleLaunch).toMatchObject({
      sessionGeneration: 'g',
      saved: true,
    });
  });
});

describe('OpenCode V1: choosing a new conversation', () => {
  const opencode = { worktreeId: WT, cliToolId: 'opencode' as const };

  it('drops only the remembered id', () => {
    rememberOpencodeSession(opencode, { sessionId: SESSION_ID, worktreePath });
    chooseNewOpencodeConversation({ worktreeId: WT, instanceId: undefined });
    expect(getRememberedOpencodeSession(opencode)).toBeNull();
  });

  it('with nothing noted there is nothing to say', () => {
    expect(takeOpencodeResumeNotice({ worktreeId: WT, instanceId: undefined })).toBeNull();
  });
});
