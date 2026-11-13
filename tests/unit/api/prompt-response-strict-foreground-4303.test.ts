/**
 * Issue #4303 review (#4303-A, P1/P2): the strict `respond` route, a refusal
 * right before its first key is "not sent" end to end.
 *
 * - The read before the first key ends by asking who holds the pane (after the
 *   capture, before the token is consumed). `shell` there — the agent gone
 *   between admission and the key — is a 409 `agent_not_in_foreground`: no
 *   key, no `prompt_answered_human` row, the token unspent (the same request,
 *   sent again once the agent is back, is answered). The first version threw at
 *   the key instead: exit 41, `partial`, a row saying an answer went.
 * - The foreground read at admission is an await: the session replaced while
 *   it is held (`invalidateInstanceInput`) refuses with nothing sent.
 * - A reader that rejects is `unknown`: refused, nothing sent.
 * - Negative control: `other` throughout — one Enter, recorded, as before.
 *
 * The harness is `prompt-response-strict-3756.test.ts`'s (capture, payload
 * builder and key sender stubbed; observation, token and checks real).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';

const { info, frames } = vi.hoisted(() => ({
  info: vi.fn(),
  /** What the pane shows now; the key sender moves it. */
  frames: { current: '', composer: '', running: true },
}));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const make = (module: string): import('@/lib/logger').Logger => ({
    debug: () => {},
    info: (action, data) => info(module, action, data),
    warn: () => {},
    error: () => {},
    withContext: () => make(module),
  });
  return { ...actual, createLogger: make };
});

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
      mockDb = null;
    },
  };
});

vi.mock('@/lib/cli-tools/session-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/session-ownership')>()),
  checkSessionOwnership: vi.fn().mockResolvedValue({ verdict: 'owned' }),
}));

/**
 * Who holds the pane, read by read: `queue` is used first (one entry a read),
 * then `fallback`. `hold`, when set, is awaited by the next read only.
 */
const fg = vi.hoisted(() => ({
  queue: [] as Array<'shell' | 'other' | 'unknown' | 'rejects'>,
  fallback: 'other' as 'shell' | 'other' | 'unknown' | 'rejects',
  hold: null as Promise<void> | null,
}));
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  readPaneForeground: vi.fn(async () => {
    const hold = fg.hold;
    fg.hold = null;
    if (hold !== null) await hold;
    const next = fg.queue.length > 0 ? fg.queue.shift()! : fg.fallback;
    if (next === 'rejects') throw new Error('reader rejected (test)');
    return next;
  }),
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
  // Issue #3788: agy in front unless a test says otherwise.
  readSessionPaneCommand: vi.fn().mockResolvedValue('agy'),
  sendSessionAnswerKey: vi.fn(async (_id: string, _tool: string, key: string) => {
    if (key === 'Enter') frames.current = frames.composer;
  }),
}));

vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => {
    const idle = frames.current === frames.composer;
    return {
      isRunning: frames.running,
      sessionName: 'mcbd-antigravity-wt-3756-route',
      sessionStatus: idle ? 'ready' : 'waiting',
      sessionStatusReason: idle ? 'input_prompt' : 'antigravity_selection_list',
      fullOutput: frames.current,
      isPromptWaiting: false,
      promptData: null,
      promptView: null,
      isSelectionListActive: !idle,
      isPagerActive: false,
      isDismissablePanelActive: false,
      isUnclassifiedActive: false,
      startingSince: null,
      serverPollerActive: false,
    };
  }),
}));

vi.mock('@/lib/session/agent-event-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/agent-event-state')>()),
  getAgentEventGenerationStartedAt: vi.fn(() => 1_800_000_000_000),
}));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/worktrees/[id]/prompt-response/strict/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { observeSession } from '@/lib/prompt-observation/session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { sendSessionAnswerKey } from '@/lib/session/cli-session';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { clearStrictRespondState } from '@/lib/prompt-observation/strict-respond';
import type { CurrentOutputPayload } from '@/lib/session/current-output-types';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { invalidateInstanceInput, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { readPaneForeground } from '@/lib/tmux/tmux';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const TRUST = read('prompt-observation-3755/antigravity-trust.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');
const FOLDER = '/Users/agy-user/share/work/github_kewton/CommandAgent-issue-643-tools-bash-cd-next-js-id-635-637';

let worktreeSeq = 0;
let WT = '';

function post(body: Record<string, unknown>): Promise<Response> {
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/prompt-response/strict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  return POST(request, { params: Promise.resolve({ id: WT }) });
}

/** The token `commandmate prompt` would print for the pane as it is now. */
async function observedToken(): Promise<string> {
  const payload = (await vi.mocked(buildCurrentOutput)(null as never, WT, 'antigravity')) as CurrentOutputPayload;
  const token = observeSession(WT, { cliToolId: 'antigravity', instanceId: 'antigravity' }, payload).screen?.token;
  if (!token) throw new Error('no token for the fixture');
  return token;
}

async function body(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    expectScreen: 'antigravity-trust',
    observation: await observedToken(),
    answer: 'Yes',
    expectTarget: FOLDER,
    operationId: `op-4303-${worktreeSeq}-${Math.random().toString(36).slice(2, 10)}`,
    answeredBy: 'agent:wt-orchestrator/claude',
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  fg.queue = [];
  fg.fallback = 'other';
  fg.hold = null;
  resetInstanceInputLocks();
  clearStrictRespondState();
  clearAllAutoYesStates();
  WT = `wt-4303-strict-route-${++worktreeSeq}`;
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'Strict',
    path: '/nonexistent-3756/strict',
    repositoryPath: '/nonexistent-3756',
    repositoryName: 'Strict',
    cliToolId: 'antigravity',
  });
  frames.current = TRUST;
  frames.composer = COMPOSER;
  frames.running = true;
});


async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('[#4303 review P2] the strict answer refused right before its first key is not sent', () => {
  it('shell after the screen read: 409 agent_not_in_foreground, no key, no record, the token still good', async () => {
    const request = await body();
    // Admission: the agent. The read before the first key: the shell.
    fg.queue = ['other', 'shell'];
    const response = await post(request);
    const result = await json(response);

    expect(response.status).toBe(409);
    expect(result).toMatchObject({ code: 'agent_not_in_foreground' });
    expect(String(result.error)).toContain('Nothing was sent');
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalledWith('api/prompt-response-strict', 'strict-prompt-answered', expect.anything());

    // The token was not consumed and the operation not kept: the same request
    // answers once the agent holds the pane again.
    const again = await json(await post(request));
    expect(again).toMatchObject({ code: 0, keysSent: 1 });
    expect(vi.mocked(sendSessionAnswerKey).mock.calls.map((call) => call[2])).toEqual(['Enter']);
  });

  it.each(['unknown', 'rejects'] as const)('%s after the screen read: 409, no key, no record', async (foreground) => {
    const request = await body();
    fg.queue = ['other', foreground];
    const response = await post(request);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'agent_not_in_foreground' });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
  });

  it('a reader that rejects at admission: 409, no key', async () => {
    const request = await body();
    fg.fallback = 'rejects';
    const response = await post(request);
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'agent_not_in_foreground' });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
  });
});

describe('[#4303 review P1] the ticket is checked again after the foreground read', () => {
  it('the session replaced while the read at admission was held: 409, no key, no record', async () => {
    const request = await body();
    let release: () => void = () => {};
    fg.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answering = post(request);
    for (let i = 0; i < 50 && vi.mocked(readPaneForeground).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(readPaneForeground).toHaveBeenCalledTimes(1);
    const sessionName = vi.mocked(readPaneForeground).mock.calls[0][0];
    invalidateInstanceInput(sessionName);
    release();
    const response = await answering;

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: 'session_replaced' });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
  });

  it('negative control: held and released with nothing changed — one Enter, recorded', async () => {
    const request = await body();
    let release: () => void = () => {};
    fg.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answering = post(request);
    for (let i = 0; i < 50 && vi.mocked(readPaneForeground).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    const response = await answering;

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ code: 0, keysSent: 1 });
    expect(vi.mocked(sendSessionAnswerKey).mock.calls.map((call) => call[2])).toEqual(['Enter']);
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
  });
});
