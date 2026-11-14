/**
 * Issue #4385 PR1: Antigravity's send gate, through the real driver.
 *
 * `docs/design/agy-role-default-4385.md` §0.1: a body goes to an Antigravity
 * instance whose settings give it a role only when this server holds a positive
 * record ("applied, confirmed") for the generation now running. No record, a
 * record that went away, unknown or unreadable: nothing is sent.
 *
 * What runs for real: `BaseCLITool.startSession` → `AntigravityTool` (launch,
 * readiness, the gate) → the shared submit-verified sender, the role layer on an
 * in-memory database, the stop API (`kill-session`) and the roles API. What is
 * replaced: tmux (a pane drawn from the state below), the liveness probe and
 * `child_process` (the paste buffer). No agy, tmux or server is started; the
 * generated agent file goes under `os.tmpdir()`.
 *
 * Every refusal is counted as: body 0, Enter after a body 0, Ctrl-D 0, kill 0.
 *
 * @vitest-environment node
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { Worktree } from '@/types/models';

/** The pane: what it shows, what was typed into it. */
const pane = vi.hoisted(() => ({
  exists: false,
  live: true,
  kind: 'blank' as 'blank' | 'trust' | 'idle' | 'generating',
  agent: 'role' as 'role' | 'none' | 'prefix',
  composer: '',
  extraRows: [] as string[],
  captureFails: false,
  afterLaunch: null as null | (() => void),
  onCapture: null as null | (() => Promise<void>),
  onLoadBuffer: null as null | (() => Promise<void>),
  events: [] as Array<{ type: 'line' | 'body' | 'paste' | 'load' | 'delete' | 'key' | 'kill'; text: string }>,
  name: () => 'cm-role-unknown',
}));

vi.mock('@/lib/tmux/tmux', () => {
  const press = (key: string) => {
    pane.events.push({ type: 'key', text: key });
    if (key === 'Enter' || key === 'C-m') {
      if (pane.kind === 'trust') pane.kind = 'idle';
      else pane.composer = '';
    }
    if (key === 'C-u') pane.composer = '';
  };
  return {
    hasSession: vi.fn(async () => pane.exists),
    createSession: vi.fn(async () => {
      pane.exists = true;
    }),
    killSession: vi.fn(async () => {
      pane.events.push({ type: 'kill', text: '' });
      pane.exists = false;
      return true;
    }),
    capturePane: vi.fn(async () => {
      if (pane.onCapture) {
        const hook = pane.onCapture;
        pane.onCapture = null;
        await hook();
      }
      if (pane.captureFails) throw new Error("can't find pane");
      return drawPane();
    }),
    sendKeys: vi.fn(async (_session: string, text: string, _enter?: boolean, options?: { literal?: boolean }) => {
      if (options?.literal) {
        pane.events.push({ type: 'body', text });
        pane.composer = text;
        return;
      }
      pane.events.push({ type: 'line', text });
      pane.afterLaunch?.();
    }),
    sendSpecialKey: vi.fn(async (_session: string, key: string) => press(key)),
    sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
      for (const key of keys) press(key);
    }),
    clearInputLine: vi.fn(async () => {
      pane.composer = '';
    }),
    clearComposerLine: vi.fn(async () => {
      pane.composer = '';
    }),
    clearComposerPasteToken: vi.fn(async () => undefined),
    readPaneForeground: vi.fn(async () => null),
    reconcileSessionGeometry: vi.fn(async () => false),
    getSessionWorkingDirectory: vi.fn(async () => '/unused'),
    exactTarget: (name: string) => `=${name}:`,
  };

  function drawPane(): string {
    const name = pane.agent === 'prefix' ? `${pane.name()}x` : pane.name();
    const model = pane.agent === 'none' ? 'auto · Gemini 4 Hydrogen · high' : `auto · ${name} (Gemini 4 Hydrogen · high)  /agents`;
    const rule = '─'.repeat(120);
    switch (pane.kind) {
      case 'blank':
        return [...pane.extraRows, ''].join('\n');
      case 'trust':
        return [
          ...pane.extraRows,
          'Accessing workspace:',
          '/tmp/wt',
          'Do you trust the contents of this project?',
          'Antigravity CLI requires permission to read, edit, and execute files here.',
          '> Yes, I trust this folder',
          '  No, exit',
          '  ↑/↓ Navigate · enter Confirm',
          `${' '.repeat(60)}${model}`,
          '',
        ].join('\n');
      case 'generating':
        return [...pane.extraRows, '  ⠋ Generating', rule, '>', rule, `esc to cancel${' '.repeat(40)}${model}`, ''].join('\n');
      case 'idle':
        return [...pane.extraRows, '  OK', rule, `> ${pane.composer}`, rule, `? for shortcuts${' '.repeat(40)}${model}`, ''].join('\n');
    }
  }
});
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeSessionLiveness: vi.fn(async () => ({ alive: pane.live, reason: 'test' })),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  exec: vi.fn(() => {
    throw new Error('no process is started in this test');
  }),
  spawn: vi.fn(() => {
    throw new Error('no process is started in this test');
  }),
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    let stdin = '';
    const finish = async () => {
      if (args[0] === 'load-buffer') {
        pane.events.push({ type: 'load', text: stdin });
        if (pane.onLoadBuffer) {
          const hook = pane.onLoadBuffer;
          pane.onLoadBuffer = null;
          await hook();
        }
      } else if (args[0] === 'paste-buffer') {
        pane.events.push({ type: 'paste', text: '' });
        pane.composer = [...pane.events].reverse().find((e) => e.type === 'load')?.text ?? '';
      } else if (args[0] === 'delete-buffer') {
        pane.events.push({ type: 'delete', text: '' });
      }
      callback(null);
    };
    setTimeout(() => void finish(), 0);
    return { stdin: { end: (data: string) => { stdin = data; } } };
  }),
}));
vi.mock('@/lib/ws-server', () => ({ broadcast: vi.fn() }));
/** Which paths git would say share a repository (their common dir). None by default. */
const gitDirs = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/git/git-common-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-common-dir')>()),
  probeGitCommonDir: vi.fn(async (repoPath: string) => {
    const commonDir = gitDirs.get(repoPath);
    return commonDir === undefined ? { kind: 'not-repository' } : { kind: 'repository', commonDir };
  }),
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

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createRepository } from '@/lib/db/db-repository';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { createAgentRole, getLatestRoleLaunchRecords, setRepositoryRoleState, setSystemRoleDefault } from '@/lib/db/agent-roles-db';
import { setRepositoryEnabled } from '@/lib/db/db-repository';
import {
  applyRoleApplicationObservation,
  expireRoleApplication,
  getLaunchRoleEvidence,
  readRoleApplication,
  resetLaunchRoleStateForTest,
  resolveLaunchRole,
  runWithLaunchRole,
  setLaunchRoleDatabaseForTest,
} from '@/lib/session/role-launch';
import { beginAgentSession, buildAgentLaunchCommandLine } from '@/lib/session/agent-session-lifecycle';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { fixedEnvReader } from '@/lib/agent-roles/composition';
import { readRoleLaunchRefusal, ROLE_LAUNCH_REFUSED_CODE } from '@/lib/agent-roles/launch-errors';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { AntigravityTool, setAgyVersionReaderForTest } from '@/lib/cli-tools/antigravity';
import { clearStartupTrust } from '@/lib/cli-tools/antigravity-startup-trust';
import { AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR } from '@/types/agent-roles';
import { POST as killSessionRoute } from '@/app/api/worktrees/[id]/kill-session/route';
import { PUT as putInstanceRole } from '@/app/api/worktrees/[id]/instances/roles/route';
import { answerSendFailure } from '@/app/api/worktrees/[id]/send/send-failure';
import { PUT as putRepository } from '@/app/api/repositories/[id]/route';
import { PUT as putRepositoryRoleDefault } from '@/app/api/repositories/[id]/role-defaults/route';

const WT = 'wt-4385';
const TARGET = { worktreeId: WT, cliToolId: 'antigravity' as const, instanceId: 'antigravity' };
const BODY = 'ROLE_BODY_MARKER: write like a tester.';
const LONG = `${'x'.repeat(600)} long body`;

let dir: string;
let worktreePath: string;
let db: Database.Database;
let roleId: string;
let otherRoleId: string;
let tool: AntigravityTool;
let rootId: string;

type Outcome = { ok: true } | { ok: false; error: Error };

/** The real `setImmediate`, taken before any test fakes the clock. */
const realSetImmediate = setImmediate;
const yieldToRealLoop = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve));
/** Only a guard against a hang; the loop below ends on the work's own state. */
const REAL_TIME_GUARD_MS = 120_000;
const FAKE_STEP_MS = 250;

/**
 * Drive the fake clock until `isDone()` (re-instruction 2 of PR1: the CI shard
 * ran out of a fixed number of steps while the work still waited on real I/O).
 *
 * The clock moves only when nothing real is left to finish: the real event loop
 * is let run first, and when no fake timer is pending the work is waiting on
 * real I/O (a module loading, a file), so the loop waits for that instead of
 * moving the clock past a deadline the work has not reached yet. The end is the
 * work's state; wall time only guards against a hang.
 */
async function driveFakeClockUntil(isDone: () => boolean): Promise<void> {
  const started = process.hrtime.bigint();
  while (!isDone()) {
    for (let i = 0; i < 3 && !isDone(); i += 1) await yieldToRealLoop();
    if (isDone()) return;
    if (Number((process.hrtime.bigint() - started) / 1_000_000n) > REAL_TIME_GUARD_MS) {
      throw new Error('the work never settled');
    }
    if (vi.getTimerCount() === 0) continue;
    await vi.advanceTimersByTimeAsync(FAKE_STEP_MS);
  }
}

/** Run `work` on the fake clock until it settles. */
async function settle(work: Promise<unknown>): Promise<Outcome> {
  let outcome: Outcome | null = null;
  work.then(
    () => {
      outcome = { ok: true };
    },
    (error: Error) => {
      outcome = { ok: false, error };
    }
  );
  await driveFakeClockUntil(() => outcome !== null);
  return outcome as unknown as Outcome;
}

const launch = () => settle(tool.startSession(WT, worktreePath, 'antigravity'));
const send = (message = 'hello') => settle(tool.sendMessage(WT, message, 'antigravity'));

const count = (type: string, text?: string) =>
  pane.events.filter((e) => e.type === type && (text === undefined || e.text === text)).length;
/** Bodies typed or pasted. */
const bodies = () => count('body') + count('paste');
/** Enter pressed after the first body. */
function bodyEnters(): number {
  const first = pane.events.findIndex((e) => e.type === 'body' || e.type === 'paste');
  if (first < 0) return 0;
  return pane.events.slice(first).filter((e) => e.type === 'key' && (e.text === 'Enter' || e.text === 'C-m')).length;
}

/** Nothing reached the pane, and nothing stopped it. */
function expectNothingSent(outcome: Outcome, reason: 'not-applied' | 'not-confirmed', before = 0): Error {
  expect(outcome.ok, 'the send must be refused').toBe(false);
  const error = (outcome as { error: Error }).error;
  expect(readRoleLaunchRefusal(error)).toBe(reason);
  expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'role-launch-refused' });
  expect(error.message).toContain('nothing was sent');
  expect(bodies()).toBe(before);
  if (before === 0) expect(bodyEnters()).toBe(0);
  expect(count('key', 'C-d')).toBe(0);
  expect(count('kill')).toBe(0);
  return error;
}

function expectSent(outcome: Outcome, total = 1): void {
  if (!outcome.ok) throw outcome.error;
  expect(bodies()).toBe(total);
}

/** The human's stop, through the real route, with the tool's kill failing as given. */
async function stopThroughApi(killFails: boolean): Promise<void> {
  const kill = vi.spyOn(tool, 'killSession');
  if (killFails) kill.mockRejectedValueOnce(new Error('tmux kill failed'));
  else kill.mockImplementationOnce(async () => {
    pane.exists = false;
  });
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/kill-session?instance=antigravity`, { method: 'POST' });
  const response = await killSessionRoute(request, { params: Promise.resolve({ id: WT }) });
  kill.mockRestore();
  // A failed kill answers 500, and the route forgets what was known all the same.
  expect(response.status).toBe(killFails ? 500 : 200);
}

/** The roles API, as the screen calls it. */
async function setRoleThroughApi(role: Record<string, unknown>): Promise<void> {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${WT}/instances/roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: 'antigravity', role }),
  });
  const response = await callRoute(() => putInstanceRole(request, { params: Promise.resolve({ id: WT }) }) as Promise<Response>);
  expect(response.status).toBe(200);
}

/**
 * Another launch takes the session (a relaunch), as a real launch leaves what is
 * known. `beginAgentSession` also revokes the composer's input ticket; without it
 * only the role's own boundary stands between the old send and the pane.
 */
async function openSuccessor(revokeInput = true): Promise<void> {
  const snapshot = await resolveLaunchRole(db, { ...TARGET, worktreePath, readEnv: fixedEnvReader({}) });
  await runWithLaunchRole(snapshot, async () => {
    if (revokeInput) beginAgentSession(TARGET);
    buildAgentLaunchCommandLine({ target: TARGET, executablePath: 'agy', worktreePath });
  });
}

/**
 * Load, before any clock is faked, the modules the paths under test load with
 * `await import()` (git's common dir for the role's membership, the poller a
 * stop ends): their loading is real I/O, and under load it must not overlap a
 * test's fake deadlines.
 */
beforeAll(async () => {
  await import('@/lib/git/git-common-dir');
  await import('@/lib/polling/response-poller');
  await import('@/lib/cli-tools/start-availability');
});

beforeEach(async () => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-agy-role-gate-4385-'));
  worktreePath = path.join(dir, 'worktree');
  fs.mkdirSync(worktreePath);
  fs.mkdirSync(path.join(dir, 'root'));
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (db: Database.Database | null) => void };
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'Agy',
    path: worktreePath,
    repositoryPath: path.join(dir, 'root'),
    repositoryName: 'repo',
    cliToolId: 'antigravity',
  } as Worktree);
  setAgentInstances(db, WT, [{ id: 'antigravity', cliTool: 'antigravity', alias: 'Agy', order: 0 }]);
  rootId = createRepository(db, { name: 'repo', path: path.join(dir, 'root'), cloneSource: 'local' }).id;
  gitDirs.clear();
  roleId = createAgentRole(db, { name: 'Tester', body: BODY }).id;
  otherRoleId = createAgentRole(db, { name: 'Writer', body: 'OTHER BODY' }).id;
  setLaunchRoleDatabaseForTest(db);
  resetSessionLaunchFlightsForTest();
  clearStartupTrust();
  setAgyVersionReaderForTest(async () => '1.5.9');
  Object.assign(pane, {
    exists: false,
    live: true,
    kind: 'blank',
    agent: 'role',
    composer: '',
    extraRows: [],
    captureFails: false,
    afterLaunch: null,
    onCapture: null,
    onLoadBuffer: null,
    events: [],
    name: () => readRoleApplication(TARGET)?.artifactName ?? 'cm-role-unknown',
  });
  vi.stubEnv(AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR, '1');
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
  vi.stubEnv('CM_AGENT_ROLE_ARTIFACTS_DIR', path.join(dir, 'data'));
  vi.stubEnv('CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR', path.join(dir, 'agy-agents'));
  vi.stubEnv('HOME', path.join(dir, 'home'));
  tool = CLIToolManager.getInstance().getTool('antigravity') as AntigravityTool;
  vi.spyOn(tool, 'isInstalled').mockResolvedValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setAgyVersionReaderForTest(null);
  resetLaunchRoleStateForTest();
  resetSessionLaunchFlightsForTest();
  clearStartupTrust();
  const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as { setMockDb: (db: Database.Database | null) => void };
  setMockDb(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A route handler called on the fake clock until it answers. */
async function callRoute(call: () => Promise<Response>): Promise<Response> {
  let response: Response | null = null;
  let failure: unknown = null;
  call().then(
    (answer) => {
      response = answer;
    },
    (error: unknown) => {
      failure = error ?? new Error('the route failed');
    }
  );
  await driveFakeClockUntil(() => response !== null || failure !== null);
  if (failure !== null) throw failure;
  return response as unknown as Response;
}

function jsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Launch with the role, the pane then showing `kind` (and the agent as `agent`). */
async function launchWithRole(kind: typeof pane.kind, agent: typeof pane.agent = 'role'): Promise<void> {
  setSystemRoleDefault(db, 'antigravity', roleId);
  pane.afterLaunch = () => {
    pane.kind = kind;
    pane.agent = agent;
  };
  const outcome = await launch();
  if (!outcome.ok) throw outcome.error;
  pane.events = [];
}

describe('Z: no positive record, no body (§8.2)', () => {
  it('Z1 starting: never drawn, refused when the grace runs out', async () => {
    await launchWithRole('blank');
    expect(readRoleApplication(TARGET)?.state).toBe('starting');
    const error = expectNothingSent(await send(), 'not-confirmed');
    expect(error.message).toContain('not confirmed in time');
    expect(readRoleApplication(TARGET)?.state).toBe('refused');
  });

  it('Z2 unknown: the screen can never be read', async () => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.captureFails = true;
    const outcome = await launch();
    if (!outcome.ok) throw outcome.error;
    expect(readRoleApplication(TARGET)?.state).toBe('unknown');
    pane.events = [];
    expectNothingSent(await send(), 'not-confirmed');
  });

  it('Z3 refused(not-applied): the input box names no agent', async () => {
    await launchWithRole('idle', 'none');
    expect(readRoleApplication(TARGET)?.state).toBe('refused');
    const error = expectNothingSent(await send(), 'not-applied');
    expect(error.message).toContain('runs without the role');
  });

  it('Z4 refused(not-confirmed), and C2: sent again and again, still nothing, nothing stopped', async () => {
    await launchWithRole('blank');
    expectNothingSent(await send(), 'not-confirmed');
    for (let i = 0; i < 3; i += 1) expectNothingSent(await send(), 'not-confirmed');
    // The process is left for a person to stop.
    expect(pane.exists).toBe(true);
  });

  it.each([
    ['starting', (): void => undefined],
    ['unknown', (): void => {
      pane.captureFails = true;
    }],
  ] as const)('Z5 a failed stop from %s forgets the record: the reconnected send is still refused', async (_state, arrange) => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    arrange();
    pane.afterLaunch = () => {
      pane.kind = 'blank';
    };
    expect((await launch()).ok).toBe(true);
    pane.captureFails = false;
    await stopThroughApi(true);
    expect(readRoleApplication(TARGET)).toBeNull();
    // The pane lives on: agy now draws its box with the role, which proves nothing about the record.
    pane.kind = 'idle';
    pane.events = [];
    const error = expectNothingSent(await send(), 'not-confirmed');
    expect(error.message).toContain('no record');
  });

  it('Z6 a failed stop after refused(not-applied): still refused', async () => {
    await launchWithRole('idle', 'none');
    await stopThroughApi(true);
    expect(readRoleApplication(TARGET)).toBeNull();
    pane.agent = 'role';
    expectNothingSent(await send(), 'not-confirmed');
  });

  it('Z7 after a server restart: the memory is empty, the send is refused (positive control first)', async () => {
    await launchWithRole('idle');
    expectSent(await send());
    resetLaunchRoleStateForTest();
    setLaunchRoleDatabaseForTest(db);
    expectNothingSent(await send(), 'not-confirmed', 1);
  });

  it('Z8 a role set through the roles API on a session started without one: refused (negative control first)', async () => {
    pane.afterLaunch = () => {
      pane.kind = 'idle';
      pane.agent = 'none';
    };
    expect((await launch()).ok).toBe(true);
    pane.events = [];
    expectSent(await send());
    await setRoleThroughApi({ state: 'role', roleId });
    expectNothingSent(await send(), 'not-confirmed', 1);
  });

  describe('Z8 (R4): "no role" decided, then a role set while the send waits', () => {
    async function launchWithoutRole(settingsElsewhere: boolean): Promise<void> {
      // With a setting elsewhere the decision reads the membership; without any, it takes the fast path.
      if (settingsElsewhere) setSystemRoleDefault(db, 'claude', roleId);
      pane.afterLaunch = () => {
        pane.kind = 'idle';
        pane.agent = 'none';
      };
      expect((await launch()).ok).toBe(true);
      pane.events = [];
    }

    it.each([false, true])('short body (settings elsewhere: %s): nothing typed, not_sent', async (elsewhere) => {
      await launchWithoutRole(elsewhere);
      pane.onCapture = () => setRoleThroughApi({ state: 'role', roleId });
      const error = expectNothingSent(await send(), 'not-confirmed');
      expect(error.message).toContain('settings changed');
    });

    it.each([false, true])('long body (settings elsewhere: %s): loaded, never pasted, buffer dropped', async (elsewhere) => {
      await launchWithoutRole(elsewhere);
      pane.onLoadBuffer = () => setRoleThroughApi({ state: 'role', roleId });
      expectNothingSent(await send(LONG), 'not-confirmed');
      expect(count('load')).toBe(1);
      expect(count('delete')).toBe(1);
    });

    it('control: the settings left alone, the body goes once', async () => {
      await launchWithoutRole(true);
      pane.onCapture = async () => undefined;
      expectSent(await send());
      expect(bodyEnters()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Z8 (review 5-2b): the other inputs of "no role" change while the send waits', () => {
    let otherRootId: string;

    /**
     * Two registered roots of one git (the worktree's own root A, enabled and
     * inheriting; root B, disabled, with a role for Antigravity): only A counts,
     * so the decision is "no role".
     */
    async function launchWithDisabledRoleRoot(): Promise<void> {
      const rootB = path.join(dir, 'root-b');
      fs.mkdirSync(rootB);
      for (const where of [path.join(dir, 'root'), rootB, worktreePath]) gitDirs.set(where, path.join(dir, 'root', '.git'));
      otherRootId = createRepository(db, { name: 'repo-b', path: rootB, cloneSource: 'local' }).id;
      setRepositoryRoleState(db, otherRootId, 'antigravity', { state: 'role', roleId });
      setRepositoryEnabled(db, otherRootId, false);
      pane.afterLaunch = () => {
        pane.kind = 'idle';
        pane.agent = 'none';
      };
      expect((await launch()).ok).toBe(true);
      expect(readRoleApplication(TARGET)).toBeNull();
      pane.events = [];
    }

    const enableRootB = async (): Promise<void> => {
      const response = await callRoute(() =>
        putRepository(jsonRequest(`http://localhost:3000/api/repositories/${otherRootId}`, { enabled: true }), {
          params: Promise.resolve({ id: otherRootId }),
        }) as Promise<Response>
      );
      expect(response.status).toBe(200);
    };
    const setRootADefault = async (): Promise<void> => {
      const response = await callRoute(() =>
        putRepositoryRoleDefault(
          jsonRequest(`http://localhost:3000/api/repositories/${rootId}/role-defaults`, {
            cliToolId: 'antigravity',
            role: { state: 'role', roleId: otherRoleId },
          }),
          { params: Promise.resolve({ id: rootId }) }
        ) as Promise<Response>
      );
      expect(response.status).toBe(200);
    };

    it.each([
      ['a root enabled (repositories API)', 'short', enableRootB],
      ['a root enabled (repositories API)', 'long', enableRootB],
      ['a repository default set (role-defaults API)', 'short', setRootADefault],
      ['a repository default set (role-defaults API)', 'long', setRootADefault],
    ] as const)('%s, %s body: nothing typed, not_sent', async (_label, size, change) => {
      await launchWithDisabledRoleRoot();
      if (size === 'short') pane.onCapture = change;
      else pane.onLoadBuffer = change;
      const error = expectNothingSent(await send(size === 'short' ? 'hello' : LONG), 'not-confirmed');
      expect(error.message).toContain('settings changed');
    });

    it('control: the roots and defaults left alone, the body goes once', async () => {
      await launchWithDisabledRoleRoot();
      pane.onCapture = async () => undefined;
      expectSent(await send());
      // And once the root is enabled, the next send is gated (no record for this process).
      await enableRootB();
      expectNothingSent(await send(), 'not-confirmed', 1);
    });
  });

  it('Z9 settings that cannot be read: refused', async () => {
    await launchWithRole('idle');
    const closed = new Database(':memory:');
    closed.close();
    setLaunchRoleDatabaseForTest(closed);
    const error = expectNothingSent(await send(), 'not-confirmed');
    expect(error.message).toContain('could not be read');
  });

  it.each([
    ['short', 'hello'],
    ['long', LONG],
  ] as const)('Z10 (%s) another generation opened after the gate, before the body: refused', async (kind, message) => {
    await launchWithRole('idle');
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    if (kind === 'short') {
      // The wait reads once; the next read is the sender's, under the input lock.
      let reads = 0;
      const hook = async (): Promise<void> => {
        reads += 1;
        if (reads < 2) {
          pane.onCapture = hook;
          return;
        }
        await openSuccessor(false);
      };
      pane.onCapture = hook;
    } else {
      pane.onLoadBuffer = () => openSuccessor(false);
    }
    const error = expectNothingSent(await send(message), 'not-confirmed');
    expect(error.message).toContain('another process');
    if (kind === 'long') expect(count('delete')).toBe(1);
  });
});

describe('C: with a positive record, and the other controls (§8.3)', () => {
  it('positive: confirmed at launch, the input box ready, the body goes once', async () => {
    await launchWithRole('idle');
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    expectSent(await send());
    expect(bodyEnters()).toBeGreaterThanOrEqual(1);
    const records = getLatestRoleLaunchRecords(db, WT, 'antigravity');
    expect(records.launched?.sessionGeneration).toBe(getLaunchRoleEvidence(TARGET)?.sessionGeneration);
  });

  it('C1 `requested` matching the settings is not a confirmation: the default agent on screen refuses', async () => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.afterLaunch = () => {
      pane.kind = 'idle';
      pane.agent = 'none';
    };
    // Only the launch's own read of the screen fails.
    const observe = vi.spyOn(tool as unknown as { observeRole: () => Promise<unknown> }, 'observeRole');
    observe.mockRejectedValueOnce(new Error('capture failed'));
    expect((await launch()).ok).toBe(true);
    observe.mockRestore();
    expect(readRoleApplication(TARGET)?.state).toBe('unknown');
    const records = getLatestRoleLaunchRecords(db, WT, 'antigravity');
    expect(records.requested?.injectionFingerprint).toBe(getLaunchRoleEvidence(TARGET)?.injectionFingerprint);
    pane.events = [];
    expectNothingSent(await send(), 'not-applied');
    expect(getLatestRoleLaunchRecords(db, WT, 'antigravity').launched).toBeNull();
  });

  it('C4 a late positive reading of the same generation does not undo a refusal', async () => {
    await launchWithRole('blank');
    const before = readRoleApplication(TARGET)!;
    applyRoleApplicationObservation(TARGET, before, { kind: 'not-applied', cause: 'role-not-selected' });
    const after = applyRoleApplicationObservation(TARGET, before, { kind: 'confirmed' });
    expect(after?.state).toBe('refused');
    // Nor does an old reading taken before a version change, even from starting.
    await launchWithRoleAgain();
    const seen = readRoleApplication(TARGET)!;
    applyRoleApplicationObservation(TARGET, seen, { kind: 'unreadable' });
    expect(applyRoleApplicationObservation(TARGET, seen, { kind: 'confirmed' })?.state).toBe('unknown');
    expect(expireRoleApplication(TARGET, seen)?.state).toBe('unknown');
    pane.kind = 'idle';
    pane.agent = 'none';
    pane.events = [];
    expectNothingSent(await send(), 'not-applied');
  });

  async function launchWithRoleAgain(): Promise<void> {
    await stopThroughApi(false);
    pane.afterLaunch = () => {
      pane.kind = 'blank';
    };
    expect((await launch()).ok).toBe(true);
  }

  it.each([
    ['short', 'hello'],
    ['long', LONG],
  ] as const)('C5 (%s) a send waiting on G, then a stop and a successor: the old send types nothing and leaves the successor alone', async (_kind, message) => {
    await launchWithRole('blank');
    const waiting = tool.sendMessage(WT, message, 'antigravity');
    const outcome = settle(waiting);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopThroughApi(false);
    await openSuccessor();
    const successor = readRoleApplication(TARGET)!;
    const result = await outcome;
    expectNothingSent(result, 'not-confirmed');
    const now = readRoleApplication(TARGET)!;
    expect(now.generation).toBe(successor.generation);
    expect(now.state).toBe('starting');
  });

  it('C7 the trust screen drawn 61 s after the launch, with the role: confirmed in the grace, one trust Enter, the body once', async () => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    const launchedAt = Date.now();
    pane.afterLaunch = () => {
      pane.kind = 'blank';
    };
    const late = setTimeout(() => {
      pane.kind = 'trust';
    }, 61_000);
    expect((await launch()).ok).toBe(true);
    expect(Date.now() - launchedAt).toBeLessThan(61_000);
    expect(readRoleApplication(TARGET)?.state).toBe('starting');
    const keysBefore = count('key', 'Enter');
    expectSent(await send(), 1);
    clearTimeout(late);
    const trustEnters = pane.events.slice(0, pane.events.findIndex((e) => e.type === 'body')).filter((e) => e.type === 'key' && e.text === 'Enter').length;
    expect(trustEnters - keysBefore).toBe(1);
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
  });

  it('C7 confirmed while agy is still generating: no body until the box is ready, then one', async () => {
    await launchWithRole('trust');
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    pane.kind = 'generating';
    const outcome = settle(tool.sendMessage(WT, 'hello', 'antigravity'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(bodies()).toBe(0);
    pane.kind = 'idle';
    expectSent(await outcome);
  });

  it('C7 (review 5-2b) the role named while agy is still generating from the start: confirmed, not refused when the box is slow', async () => {
    await launchWithRole('generating');
    // The launch's own read saw the name on the busy box's status row.
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    // Still generating past the whole wait: not ready, and not a role refusal.
    const first = await send();
    expect(first.ok).toBe(false);
    expect(readRoleLaunchRefusal((first as { error: Error }).error)).toBeNull();
    expect(bodies()).toBe(0);
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    pane.kind = 'idle';
    expectSent(await send());
  });

  it('C7 (review 5-2b) a busy box without the name proves nothing: still waiting, confirmed once the name shows', async () => {
    await launchWithRole('generating', 'none');
    expect(readRoleApplication(TARGET)?.state).toBe('starting');
    const outcome = settle(tool.sendMessage(WT, 'hello', 'antigravity'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readRoleApplication(TARGET)?.state).toBe('starting');
    pane.kind = 'idle';
    pane.agent = 'role';
    expectSent(await outcome);
  });

  it('C8 refused, then a successful stop and a new confirmed generation: the body goes, `launched` names the new one', async () => {
    await launchWithRole('idle', 'none');
    expectNothingSent(await send(), 'not-applied');
    await stopThroughApi(false);
    pane.afterLaunch = () => {
      pane.kind = 'idle';
      pane.agent = 'role';
    };
    expect((await launch()).ok).toBe(true);
    pane.events = [];
    expectSent(await send());
    expect(getLatestRoleLaunchRecords(db, WT, 'antigravity').launched?.sessionGeneration).toBe(
      getLaunchRoleEvidence(TARGET)?.sessionGeneration
    );
  });

  it('C9 agy stopped on a tool it does not register: the tool named, none of its output quoted', async () => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.afterLaunch = () => {
      pane.live = false;
      pane.kind = 'blank';
      pane.extraRows = [`$ agy --agent ${pane.name()}`, 'error: unknown component: tool "swarm"', `error: ${BODY}`];
    };
    expect((await launch()).ok).toBe(true);
    expect(readRoleApplication(TARGET)?.refusal).toMatchObject({ cause: 'unknown-tool', toolName: 'swarm' });
    pane.events = [];
    const outcome = await send();
    // agy is gone, so the send relaunches it, and the new process fails the same way.
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: Error }).error;
    expect(readRoleLaunchRefusal(error)).toBe('not-applied');
    expect(error.message).toContain('tool "swarm"');
    expect(error.message).toContain('agy 1.5.9, checked on 1.5.8');
    expect(error.message).not.toContain('ROLE_BODY_MARKER');
    expect(bodies()).toBe(0);
    expect(count('key', 'C-d')).toBe(0);
  });

  it.each([
    ['a name that only shares the prefix', (): void => {
      pane.agent = 'prefix';
    }],
    ['the name quoted above the box, not on its status row', (): void => {
      pane.agent = 'none';
      pane.extraRows = [`  auto · ${pane.name()} (Gemini 4 Hydrogen · high)  /agents`];
    }],
  ])('C9 %s is not a confirmation', async (_label, arrange) => {
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.afterLaunch = () => {
      pane.kind = 'idle';
      arrange();
    };
    expect((await launch()).ok).toBe(true);
    pane.events = [];
    expectNothingSent(await send(), 'not-applied');
  });

  it('C10 a confirmation inside the gate writes `launched` for the launch\'s own generation; a failed write changes nothing', async () => {
    await launchWithRole('blank');
    const requested = getLatestRoleLaunchRecords(db, WT, 'antigravity').requested!;
    const outcome = settle(tool.sendMessage(WT, 'hello', 'antigravity'));
    await vi.advanceTimersByTimeAsync(3_000);
    pane.kind = 'idle';
    expectSent(await outcome);
    const launched = getLatestRoleLaunchRecords(db, WT, 'antigravity').launched!;
    expect(launched.sessionGeneration).toBe(requested.sessionGeneration);
    expect(launched.injectionFingerprint).toBe(requested.injectionFingerprint);

    // The same, with the record's write failing: the body still goes.
    await stopThroughApi(false);
    pane.afterLaunch = () => {
      pane.kind = 'blank';
    };
    expect((await launch()).ok).toBe(true);
    pane.events = [];
    const failing = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('INSERT INTO agent_role_launch_records')) throw new Error('disk full');
      return Database.prototype.prepare.call(db, sql);
    }) as typeof db.prepare);
    const second = settle(tool.sendMessage(WT, 'hello', 'antigravity'));
    await vi.advanceTimersByTimeAsync(3_000);
    pane.kind = 'idle';
    expectSent(await second);
    failing.mockRestore();
    expect(readRoleApplication(TARGET)?.state).toBe('confirmed');
    expect(getLatestRoleLaunchRecords(db, WT, 'antigravity').launched?.sessionGeneration).not.toBe(
      getLaunchRoleEvidence(TARGET)?.sessionGeneration
    );
  });

  it('C11 the refusal reaches the send answer as roleRefusal, not sent', async () => {
    await launchWithRole('blank');
    const outcome = await send();
    const error = expectNothingSent(outcome, 'not-confirmed');
    const answer = await answerSendFailure(
      { stage: 'send', error: error.message },
      {
        cliTool: tool,
        worktreeId: WT,
        instanceId: 'antigravity',
        model: undefined,
        sendAttemptInstance: 'antigravity',
        ownAttempt: classifySendFailure(error),
        sendStartedAt: Date.now(),
        trimmedContent: 'hello',
      } as unknown as Parameters<typeof answerSendFailure>[1]
    );
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: ROLE_LAUNCH_REFUSED_CODE, roleRefusal: 'not-confirmed' });
  });

  it('C12 switch off (the PR1 default): with a role set or not, sends are as before', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    vi.stubEnv('HOME', path.join(dir, 'home'));
    pane.afterLaunch = () => {
      pane.kind = 'idle';
      pane.agent = 'none';
    };
    expect((await launch()).ok).toBe(true);
    pane.events = [];
    expectSent(await send(), 1);
    // A role set afterwards does not gate it while the switch is off.
    setSystemRoleDefault(db, 'antigravity', roleId);
    pane.onCapture = async () => undefined;
    expectSent(await send(), 2);
    expect(readRoleApplication(TARGET)).toBeNull();
  });

  it('C13 the role changed to another one while confirmed: the body goes (the running role waits for a restart)', async () => {
    await launchWithRole('idle');
    await setRoleThroughApi({ state: 'role', roleId: otherRoleId });
    expectSent(await send());
  });

  it('a role removed while confirmed or not: the gate no longer applies', async () => {
    await launchWithRole('idle', 'none');
    await setRoleThroughApi({ state: 'none' });
    expectSent(await send());
  });
});
