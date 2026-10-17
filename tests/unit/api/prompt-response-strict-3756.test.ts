/**
 * `POST /api/worktrees/:id/prompt-response/strict` (Issue #3756): the route
 * around the strict respond — body validation, the fresh read it hands the
 * checks, the keys it sends, and the record it leaves in server.log and the
 * task's history.
 *
 * The capture, the payload builder and the key sender are stubbed; the
 * observation, the token and every check are the real ones.
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

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: vi.fn().mockResolvedValue(''),
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
import { captureSessionOutputFresh, sendSessionAnswerKey } from '@/lib/session/cli-session';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { clearStrictRespondState } from '@/lib/prompt-observation/strict-respond';
import type { CurrentOutputPayload } from '@/lib/session/current-output-types';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');
const TRUST = read('prompt-observation-3755/antigravity-trust.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');
const PLAN_REVIEW = read('command-code-plan-review-3125/plan-review-1-74-0-initial.txt');
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
    operationId: `op-route-${worktreeSeq}-${Math.random().toString(36).slice(2, 10)}`,
    answeredBy: 'agent:wt-orchestrator/claude',
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearStrictRespondState();
  WT = `wt-3756-route-${++worktreeSeq}`;
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

describe('[#3756] the strict endpoint answers the trust screen', () => {
  it('sends one Enter for Yes, and records who answered what in server.log and the task history', async () => {
    const response = await post(await body());
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ strictRespond: 1, code: 0, outcome: 'advanced', answer: { position: 1 } });
    expect(vi.mocked(sendSessionAnswerKey).mock.calls).toEqual([[WT, 'antigravity', 'Enter', 'antigravity']]);

    expect(info).toHaveBeenCalledWith(
      'api/prompt-response-strict',
      'strict-prompt-answered',
      expect.objectContaining({
        worktreeId: WT,
        answeredBy: 'agent:wt-orchestrator/claude',
        observedKind: 'antigravity-trust',
        approvalTarget: FOLDER,
        option: { position: 1, label: 'Yes, I trust this folder' },
      })
    );
    expect(applyEventToActiveTask).toHaveBeenCalledTimes(1);
    const [, worktreeId, cliToolId, instanceId, event, payload] = vi.mocked(applyEventToActiveTask).mock.calls[0];
    expect([worktreeId, cliToolId, instanceId, event]).toEqual([WT, 'antigravity', 'antigravity', 'prompt_answered_human']);
    expect(payload).toMatchObject({ promptType: 'antigravity-trust' });
    expect(payload?.reason).toContain('agent:wt-orchestrator/claude');
    expect(payload?.reason).toContain('"Yes, I trust this folder"');
    expect(payload?.reason).toContain(FOLDER);
  });
});

describe('[#3756] the strict endpoint stops before any side effect', () => {
  it('a failed capture sends nothing (the old route carries on after one)', async () => {
    const request = await body();
    vi.mocked(captureSessionOutputFresh).mockRejectedValueOnce(new Error('tmux gone'));
    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, reason: 'capture_failed', delivery: 'not-sent' });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
    expect(applyEventToActiveTask).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('api/prompt-response-strict', 'strict-prompt-response-refused', expect.anything());
  });

  it("Command Code's plan review is never answered (the old route answers it before reading the screen)", async () => {
    const request = await body();
    frames.current = PLAN_REVIEW;
    const result = await (await post(request)).json();

    expect(result).toMatchObject({ code: 40, reason: 'kind_mismatch', expectedKind: 'antigravity-trust' });
    expect(result.observedKind).not.toBe('antigravity-trust');
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
  });

  it('a session that is not running is refused with nothing sent', async () => {
    const request = await body();
    frames.running = false;
    expect(await (await post(request)).json()).toMatchObject({ code: 40, reason: 'session_not_running' });
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
  });

  it('refuses --default, an unknown kind and a missing operation id as bad requests, marked as this route', async () => {
    for (const over of [{ useDefault: true }, { expectScreen: 'trust' }, { operationId: 'x' }]) {
      const response = await post(await body(over));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ strictRespond: 1 });
    }
    expect(sendSessionAnswerKey).not.toHaveBeenCalled();
  });
});
