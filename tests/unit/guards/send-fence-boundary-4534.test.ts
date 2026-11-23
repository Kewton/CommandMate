/**
 * Issue #4534: one send's terminal changes go through one fence — at the
 * process boundary (G-境, T7) and per failure mode (T1–T5, T8, T9).
 *
 * Real from the entry down: the send route, `/terminal`, the relay pump and the
 * timer manager; the fence; the send service; the tool drivers (claude, codex,
 * copilot, OpenCode); the shared sender; the input lock; `tmux.ts`. The DB is a
 * real in-memory one with every migration. Fake: the process boundary
 * (`./send-fence-process`: every `child_process` form and `fetch`), and reads
 * nothing here judges — the response poller, the pending-response saver, the
 * WebSocket broadcast, git, the relay readiness probe, OpenCode's port and
 * subscription registry.
 *
 * G-境: the fake process counts every call that is not a read as a change, and
 * each change must be preceded, in its own synchronous step, by a gate of the
 * open ticket that names the session the change targets ({@link ungated}).
 * Before #4534 nothing opened a ticket and no gate stood in front of any change,
 * so every T7 case is red; T1–T5 are red because the change went out after the
 * target had changed.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('child_process', async () => (await import('./send-fence-process')).fakeChildProcess());
vi.mock('@/lib/db/db-instance', () => {
  let current: unknown = null;
  return {
    getDbInstance: () => {
      if (current === null) throw new Error('no test db');
      return current;
    },
    setTestDb: (db: unknown) => {
      current = db;
    },
    closeDbInstance: () => {
      current = null;
    },
  };
});
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: vi.fn(() => []) }));
vi.mock('@/lib/assistant-response-saver', () => ({ savePendingAssistantResponse: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/terminal-broadcast')>()),
  broadcastSessionStatus: vi.fn(),
}));
vi.mock('@/lib/git/git-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/git-utils')>()),
  getGitStatus: vi.fn(async () => {
    throw new Error('not a repository');
  }),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));
vi.mock('@/lib/cli-tools/start-availability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cli-tools/start-availability')>();
  return { ...actual, reportSessionStartFailure: vi.fn(actual.reportSessionStartFailure) };
});
vi.mock('@/lib/cli-tools/opencode-config', () => ({ ensureOpencodeConfig: vi.fn() }));
vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>()),
  getAssignedOpencodePort: vi.fn(),
}));
vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>()),
  getOpencodeLiveness: vi.fn(),
  getOpencodePrimarySession: vi.fn(),
}));

import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createTimer, getTimerById } from '@/lib/db/timer-db';
import { createRelay, stashRelayPayload } from '@/lib/db/relay-db';
import type { Worktree } from '@/types/models';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { addPane, changeCommands, changes, fakeFetch, gateObserver, resetWorld, ungated, world, type Out } from './send-fence-process';
import { isFenceRefusal, openSendCount, resetFenceForTests, runWithSendTicket, SendTargetChangedError, setFenceObserver } from '@/lib/session/terminal-fence';
import { routeSendTicketInit } from '@/lib/session/send-target-names';
import { getCarriedPasteMark, resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { sendUserMessage } from '@/lib/session/send-user-message';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { reportSessionStartFailure } from '@/lib/cli-tools/start-availability';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { getOpencodeLiveness, getOpencodePrimarySession } from '@/lib/hooks/sources/opencode/subscription';
import { pumpRelayDeliveries, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { getActiveTimerCount, scheduleTimer, stopAllTimers } from '@/lib/timer-manager';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT_FRAMES } from '@tests/fixtures/copilot-model-switch-2623';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

registerIsolatedAgentHooksDir('fence4534');

const WT = 'wt-fence4534';
const WT_WORKER = 'wt-fence4534-worker';
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

let home = '';
let wtPath = '';
let db: Database.Database;
const previousHome = process.env.HOME;

beforeAll(() => {
  // Nothing here may reach the developer's own home (~/.claude, ~/.codex …).
  home = mkdtempSync(join(tmpdir(), 'fence4534-home-'));
  wtPath = mkdtempSync(join(tmpdir(), 'fence4534-wt-'));
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

beforeEach(async () => {
  resetWorld();
  world.path = wtPath;
  resetFenceForTests();
  resetInstanceInputLocks();
  resetRelayDeliveryState();
  setFenceObserver(gateObserver);
  vi.mocked(reportSessionStartFailure).mockClear();
  db = new Database(':memory:');
  runMigrations(db);
  const instance = (await import('@/lib/db/db-instance')) as unknown as { setTestDb: (d: unknown) => void };
  instance.setTestDb(db);
  for (const [id, path] of [[WT, wtPath], [WT_WORKER, `${wtPath}-worker`]] as const) {
    upsertWorktree(db, { id, name: id, path, repositoryPath: wtPath, repositoryName: 'repo', cliToolId: 'claude' } as Worktree);
  }
});
afterEach(() => {
  setFenceObserver(null);
  stopAllTimers();
  resetRelayDeliveryState();
  db.close();
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const nameOf = (tool: CLIToolType, instanceId?: string, worktreeId = WT): string => resolveSessionName(tool, worktreeId, instanceId);

function addRoster(instanceId: string, tool: CLIToolType, worktreeId = WT): void {
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, '', 0, ?)`,
  ).run(worktreeId, instanceId, tool, NOW);
}
function setRosterTool(instanceId: string, tool: CLIToolType, worktreeId = WT): void {
  db.prepare(`UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?`).run(tool, worktreeId, instanceId);
}
function dropRoster(instanceId: string, worktreeId = WT): void {
  db.prepare(`DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?`).run(worktreeId, instanceId);
}

/** Run `action` once, right after the first call `when` matches. */
function onFirst(when: (o: Out) => boolean, action: () => void): void {
  let done = false;
  world.onCall = (o) => {
    if (!done && when(o)) {
      done = true;
      action();
    }
  };
}

const isKeys = (pattern: RegExp) => (o: Out): boolean => o.line.startsWith('send-keys') && pattern.test(o.line);
const settle = <T>(p: Promise<T>): Promise<T | Error> => p.then((v) => v, (e: unknown) => e as Error);

async function postSend(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/worktrees/[id]/send/route');
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await POST(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as Response;
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function postTerminal(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import('@/app/api/worktrees/[id]/terminal/route');
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await POST(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as Response;
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** A relay from `instanceId` (the requester, typed into) with a reply waiting. */
function openRelayWithReply(instanceId: string): string {
  const relay = createRelay(db, {
    from: { worktreeId: WT, instanceId },
    to: { worktreeId: WT_WORKER, instanceId: 'claude' },
    hops: 1,
    expiresAt: NOW + DAY_MS,
    now: NOW,
  });
  expect(stashRelayPayload(db, relay.id, 'reply', 'relay reply body', NOW)).toBe(true);
  return relay.id;
}

/** Fire a timer now and wait until it has settled. */
async function fireTimer(tool: CLIToolType, instanceId: string, message: string): Promise<string> {
  const timer = createTimer(db, { worktreeId: WT, cliToolId: tool, instanceId, message, delayMs: 0 });
  scheduleTimer(timer.id, WT, 0);
  await vi.waitFor(
    () => {
      const status = getTimerById(db, timer.id)?.status;
      if (status === 'pending' || status === 'sending') throw new Error(`timer still ${status}`);
      // …and its execution is over (a row cancelled meanwhile is not the end of the send).
      if (getActiveTimerCount() > 0) throw new Error('timer still running');
    },
    { timeout: 20_000, interval: 20 },
  );
  return getTimerById(db, timer.id)?.status ?? 'gone';
}

/** The changes, one per line, with the gate that let each through. */
const permitted = (): string[] =>
  world.out.filter((o) => o.cls === 'change').map((o) => `${o.permit ?? 'none'}:${o.line.replace(/^tmux\s+/, '').split(' ')[0]}`);

// ---------------------------------------------------------------------------
// T7: G-境 — every change of every entry, gate by gate
// ---------------------------------------------------------------------------

describe('T7 G-境: entries × tools, every change behind a gate of the open ticket that names its session', () => {
  it('[T7] the send route × claude, launched by the send: 201, every change gated, the ticket closed after', async () => {
    const S = nameOf('claude');
    const { status } = await postSend({ content: 'hello fence', cliToolId: 'claude' });
    expect(status).toBe(201);
    expect(changeCommands()).toEqual([
      'new-session', 'set-option', 'new-window', 'set-window-option', 'resize-window',
      'set-environment', 'send-keys', 'send-keys', 'send-keys', 'send-keys',
    ]);
    expect(changes().filter((l) => l.includes('-l -- hello fence'))).toHaveLength(1);
    expect(ungated()).toEqual([]);
    expect(openSendCount(S)).toBe(0);
  }, 60_000);

  it('[T7] the send route × codex, launched by the send: 201, every change gated', async () => {
    const S = nameOf('codex');
    const { status } = await postSend({ content: 'hello codex', cliToolId: 'codex' });
    expect(status).toBe(201);
    expect(changeCommands().slice(0, 5)).toEqual(['new-session', 'set-option', 'new-window', 'set-window-option', 'resize-window']);
    expect(changes().filter((l) => l.includes('-l -- hello codex'))).toHaveLength(1);
    expect(ungated()).toEqual([]);
    expect(openSendCount(S)).toBe(0);
  }, 60_000);

  it('[T7] /terminal × codex on a roster instance (types not mocked): 200, the command typed once, every change gated', async () => {
    addRoster('codex-2', 'codex');
    const S = nameOf('codex', 'codex-2');
    addPane(S, 'codex');
    const { status } = await postTerminal({ cliToolId: 'codex', command: 'echo terminal', instanceId: 'codex-2' });
    expect(status).toBe(200);
    expect(changes().filter((l) => l.startsWith(`send-keys -t =${S}: -l -- echo terminal`))).toHaveLength(1);
    expect(ungated()).toEqual([]);
    expect(openSendCount(S)).toBe(0);
  }, 60_000);

  it('[T7] a relay delivery × codex: delivered, every change gated', async () => {
    addRoster('codex-r', 'codex');
    const S = nameOf('codex', 'codex-r');
    addPane(S, 'codex');
    openRelayWithReply('codex-r');
    await pumpRelayDeliveries();
    expect(changes().filter((l) => l.includes('relay reply body'))).toHaveLength(1);
    expect(ungated()).toEqual([]);
    expect(openSendCount(S)).toBe(0);
  }, 60_000);

  it('[T7] the send route × claude, a long body (the paste path): 201, the paste-buffer behind its own gate', async () => {
    const S = nameOf('claude');
    addPane(S, 'claude');
    const body = `long ${'y'.repeat(4000)}`;
    const { status } = await postSend({ content: body, cliToolId: 'claude' });
    expect(status).toBe(201);
    const pastes = world.out.filter((o) => o.cls === 'change' && o.line.startsWith('paste-buffer'));
    expect(pastes).toHaveLength(1);
    expect(pastes[0].permit).toBe('ticketed');
    expect(pastes[0].permitNames).toContain(S);
    expect(ungated()).toEqual([]);
  }, 60_000);

  it('[T7] a timer × claude: sent, every change gated', async () => {
    const S = nameOf('claude');
    addPane(S, 'claude');
    expect(await fireTimer('claude', 'claude', 'timer body')).toBe('sent');
    expect(changes().filter((l) => l.includes('-l -- timer body'))).toHaveLength(1);
    expect(ungated()).toEqual([]);
    expect(openSendCount(S)).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Each entry's own check refuses (design §2.2): relay, timer, /terminal
// ---------------------------------------------------------------------------

describe('the entry’s own check: a mismatch refuses before any change', () => {
  it('[T7-refuse] a relay delivery: the requester’s instance runs another tool after the claim → nothing typed', async () => {
    addRoster('codex-rr', 'codex');
    const S = nameOf('codex', 'codex-rr');
    addPane(S, 'codex');
    openRelayWithReply('codex-rr');
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool('codex-rr', 'claude'));
    const sent = captureToolError('codex', 'sendMessage');
    await pumpRelayDeliveries().finally(() => sent.restore());
    expect(world.out.some((o) => o.line.startsWith('capture-pane'))).toBe(true);
    expect(changes()).toEqual([]);
    expect(refusedFor(sent.error(), 'tool-changed')).toBe(true);
  }, 60_000);

  it('[T7-refuse] a timer: its row is no longer sending (cancelled meanwhile) → nothing typed', async () => {
    const S = nameOf('claude');
    addPane(S, 'claude');
    // The first read after the timer took its row (`sending`): under its ticket.
    const sending = (): boolean => (db.prepare(`SELECT COUNT(*) AS n FROM timer_messages WHERE status = 'sending'`).get() as { n: number }).n > 0;
    onFirst((o) => o.line.startsWith('capture-pane') && sending(), () => {
      db.prepare(`UPDATE timer_messages SET status = 'cancelled' WHERE status = 'sending'`).run();
    });
    const sent = captureToolError('claude', 'sendMessage');
    await fireTimer('claude', 'claude', 'timer refused').finally(() => sent.restore());
    expect(world.out.some((o) => o.line.startsWith('capture-pane'))).toBe(true);
    expect(changes()).toEqual([]);
    expect(refusedFor(sent.error(), 'target-gone')).toBe(true);
  }, 60_000);

  it('[T7-refuse] /terminal: the roster instance runs another tool after the route resolved it → nothing typed', async () => {
    addRoster('codex-tr', 'codex');
    const S = nameOf('codex', 'codex-tr');
    addPane(S, 'codex');
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool('codex-tr', 'claude'));
    const sent = captureToolError('codex', 'sendMessage');
    const { status } = await postTerminal({ cliToolId: 'codex', command: 'echo refused', instanceId: 'codex-tr' }).finally(() => sent.restore());
    expect(status).toBe(500);
    expect(changes()).toEqual([]);
    expect(refusedFor(sent.error(), 'tool-changed')).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T1 (F1, R9): the body's keys
// ---------------------------------------------------------------------------

/**
 * What one of the tool's methods threw (a spy that calls through). The layer
 * below the route's answer: the fence's reason is read off it.
 */
function captureToolError(tool: CLIToolType, method: 'sendMessage' | 'startSession'): { error: () => unknown; restore: () => void } {
  const cliTool = CLIToolManager.getInstance().getTool(tool) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cliTool[method].bind(cliTool);
  let caught: unknown = undefined;
  const spy = vi.spyOn(cliTool, method).mockImplementation((...args: unknown[]) =>
    original(...args).catch((error: unknown) => {
      caught = error;
      throw error;
    }),
  );
  return { error: () => caught, restore: () => spy.mockRestore() };
}

/** The fence's refusal with `reason`, as the error or anywhere on its cause chain, or in its text (a driver's wrap). */
function refusedFor(error: unknown, reason: string): boolean {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 10; e = (e as { cause?: unknown }).cause, depth++) {
    if (isFenceRefusal(e) && (e as { reason?: unknown }).reason === reason) return true;
    if (e instanceof Error && e.message.includes(`send target changed: ${reason}`)) return true;
  }
  return false;
}

/** The send service under the send route's ticket, as the route runs it. */
async function serviceSend(tool: CLIToolType, instanceId: string, content: string, hook = vi.fn()) {
  let attempt: { state: string; reason: string } | null = null;
  const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: tool, resolvedBy: 'roster' });
  const result = await runWithSendTicket(init, () =>
    sendUserMessage(db, {
      worktreeId: WT,
      content,
      cliToolId: tool,
      instanceId,
      inputBoundary: { beforeInput: hook },
      onAttempt: (a) => {
        attempt = a;
      },
    }),
  );
  return { result, attempt: attempt as { state: string; reason: string } | null, hookCalls: hook.mock.calls.length };
}

describe('T1 (F1, R9): the target changes around the body', () => {
  it.each([
    ['claude', 'claude-t1'],
    ['codex', 'codex-t1'],
  ] as const)('[T1] %s: the roster row goes after the route resolved it (at its health check, before the ticket opens) → the first gate refuses, no change at all', async (tool, instanceId) => {
    addRoster(instanceId, tool);
    const S = nameOf(tool, instanceId);
    addPane(S, tool, 'echo PREFILLED');
    onFirst((o) => o.line.startsWith('capture-pane'), () => dropRoster(instanceId));
    const sent = captureToolError(tool, 'sendMessage');
    try {
      const { status } = await postSend({ content: 'body t1', cliToolId: tool, instanceId });
      expect(status).toBe(500);
      expect(changes()).toEqual([]);
      expect(refusedFor(sent.error(), 'target-gone')).toBe(true);
    } finally {
      sent.restore();
    }
  }, 60_000);

  it.each([
    ['claude', 'claude-t1b'],
    ['codex', 'codex-t1b'],
  ] as const)('[T1] %s: the instance runs another tool after the clear → only the clear went out; no hook, no carried mark, not-sent', async (tool, instanceId) => {
    addRoster(instanceId, tool);
    const S = nameOf(tool, instanceId);
    addPane(S, tool, 'echo PREFILLED');
    onFirst(isKeys(/C-u/), () => setRosterTool(instanceId, tool === 'claude' ? 'codex' : 'claude'));
    const sent = captureToolError(tool, 'sendMessage');
    const { result, attempt, hookCalls } = await serviceSend(tool, instanceId, 'body t1b').finally(() => sent.restore());
    expect(result.ok).toBe(false);
    expect(refusedFor(sent.error(), 'tool-changed')).toBe(true);
    expect(changes().length).toBeGreaterThan(0);
    expect(changes().every((l) => /^send-keys .* (C-e|C-u|BSpace)/.test(l))).toBe(true);
    expect(changes().some((l) => l.includes('body t1b'))).toBe(false);
    expect(hookCalls).toBe(0);
    expect(getCarriedPasteMark(S)).toBeNull();
    expect(attempt?.state).toBe('not-sent');
    expect(ungated()).toEqual([]);
  }, 60_000);

  it('[T1] claude, a pasted body: the row goes while the buffer loads → no paste, the buffer dropped, no hook, not-sent', async () => {
    addRoster('claude-t1p', 'claude');
    const S = nameOf('claude', 'claude-t1p');
    addPane(S, 'claude');
    onFirst((o) => o.line.startsWith('load-buffer'), () => dropRoster('claude-t1p'));
    const sent = captureToolError('claude', 'sendMessage');
    const { result, attempt, hookCalls } = await serviceSend('claude', 'claude-t1p', 'x'.repeat(4000)).finally(() => sent.restore());
    expect(result.ok).toBe(false);
    expect(refusedFor(sent.error(), 'target-gone')).toBe(true);
    expect(changes()).toEqual([]);
    expect(world.out.filter((o) => o.cls === 'buffer').map((o) => o.line.split(' ')[0])).toEqual(['load-buffer', 'delete-buffer']);
    expect(hookCalls).toBe(0);
    expect(attempt?.state).toBe('not-sent');
  }, 60_000);

  it('[T1] control: nothing moves → the hook runs once, before the body, and the body is typed once', async () => {
    addRoster('claude-t1c', 'claude');
    addPane(nameOf('claude', 'claude-t1c'), 'claude', 'echo PREFILLED');
    const order: string[] = [];
    world.onCall = (o) => {
      if (o.cls === 'change') order.push(o.line.split(' ').slice(3).join(' '));
    };
    const { result, hookCalls } = await serviceSend('claude', 'claude-t1c', 'body ok', vi.fn(() => void order.push('<hook>')));
    expect(result.ok).toBe(true);
    expect(hookCalls).toBe(1);
    expect(order.indexOf('<hook>')).toBeLessThan(order.indexOf('-l -- body ok'));
    expect(ungated()).toEqual([]);
  }, 60_000);

  it('[T1] after the body went in, the target changes → indeterminate (the body may be on the pane)', async () => {
    addRoster('claude-t1i', 'claude');
    addPane(nameOf('claude', 'claude-t1i'), 'claude');
    onFirst(isKeys(/-l -- body late/), () => dropRoster('claude-t1i'));
    const sent = captureToolError('claude', 'sendMessage');
    const { result, attempt } = await serviceSend('claude', 'claude-t1i', 'body late').finally(() => sent.restore());
    expect(result.ok).toBe(false);
    expect(refusedFor(sent.error(), 'target-gone')).toBe(true);
    expect(attempt?.state).toBe('indeterminate');
    expect(changes().filter((l) => /Enter|C-m$/.test(l))).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T2 (F2): copilot's /model
// ---------------------------------------------------------------------------

describe('T2 (F2): copilot /model', () => {
  const instanceId = 'copilot-t2';
  const run = () => {
    const tool = new CopilotTool();
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: 'copilot', resolvedBy: 'roster' });
    return settle(runWithSendTicket(init, () => tool.sendModelCommand(WT, 'gpt-5.6-terra', instanceId)));
  };

  it('[T2] the instance runs another tool after the idle read → /model is not typed', async () => {
    addRoster(instanceId, 'copilot');
    const S = nameOf('copilot', instanceId);
    addPane(S, 'copilot');
    world.frame = (s) => (s === S ? COPILOT_FRAMES.SWITCH_BEFORE() : null);
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool(instanceId, 'claude'));
    const outcome = await run();
    expect(outcome).toBeInstanceOf(Error);
    expect(refusedFor(outcome, 'tool-changed')).toBe(true);
    expect(changes()).toEqual([]);
  }, 60_000);

  it('[T2] control: nothing moves → /model typed once, gated', async () => {
    addRoster(instanceId, 'copilot');
    const S = nameOf('copilot', instanceId);
    addPane(S, 'copilot');
    let frame = COPILOT_FRAMES.SWITCH_BEFORE();
    world.frame = (s) => (s === S ? frame : null);
    world.onCall = (o) => {
      if (o.line.includes('/model ')) frame = COPILOT_FRAMES.SWITCH_AFTER();
    };
    await run();
    expect(changes().filter((l) => l.includes('/model gpt-5.6-terra'))).toHaveLength(1);
    expect(ungated()).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T3 (F3, R2, R3) and T4 (I2, R7): the launch
// ---------------------------------------------------------------------------

describe('T3 (F3): the launch the send starts', () => {
  it.each([
    ['claude', 'claude-t3'],
    ['codex', 'codex-t3'],
  ] as const)('[T3] %s: the row goes before the launch → nothing created; no start-failure notice', async (tool, instanceId) => {
    addRoster(instanceId, tool);
    onFirst((o) => o.line.startsWith('has-session') || /which /.test(o.line), () => dropRoster(instanceId));
    const start = captureToolError(tool, 'startSession');
    const { status, json } = await postSend({ content: 'body t3', cliToolId: tool, instanceId }).finally(() => start.restore());
    expect(status).toBe(500);
    expect(changes()).toEqual([]);
    expect(refusedFor(start.error(), 'target-gone')).toBe(true);
    expect(String(json.error)).toContain('send target changed: target-gone');
    expect(reportSessionStartFailure).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    ['claude', 'claude-t3b'],
    ['codex', 'codex-t3b'],
  ] as const)('[T3] %s: the row goes right after new-session → the creation finishes as one change, nothing after it; the refusal comes up as itself', async (tool, instanceId) => {
    addRoster(instanceId, tool);
    onFirst((o) => o.line.startsWith('new-session'), () => dropRoster(instanceId));
    const start = captureToolError(tool, 'startSession');
    try {
      const { status, json } = await postSend({ content: 'body t3b', cliToolId: tool, instanceId });
      expect(status).toBe(500);
      expect(changeCommands()).toEqual(['new-session', 'set-option', 'new-window', 'set-window-option', 'resize-window']);
      expect(String(json.error)).toContain('send target changed: target-gone');
      expect(reportSessionStartFailure).not.toHaveBeenCalled();
      expect(ungated()).toEqual([]);
      // The refusal reaches the route's start step as its own type, through the
      // driver's launch catch too (INV-catch, r3: this replaced the codex
      // [T3-known-pr-b] test that fixed the cause-dropping wrap as known).
      expect(start.error()).toBeInstanceOf(SendTargetChangedError);
      expect(start.error()).toMatchObject({ reason: 'target-gone', delivery: 'not-started' });
    } finally {
      start.restore();
    }
  }, 60_000);
});

describe('T4 (I2, R7): the roster moves after a change that went out', () => {
  it('[T4] claude: after the launch line → no body, nothing after it', async () => {
    addRoster('claude-t4', 'claude');
    onFirst(isKeys(/CM_PORT|claude/), () => setRosterTool('claude-t4', 'codex'));
    const start = captureToolError('claude', 'startSession');
    const { status } = await postSend({ content: 'body t4', cliToolId: 'claude', instanceId: 'claude-t4' }).finally(() => start.restore());
    expect(status).toBe(500);
    expect(refusedFor(start.error(), 'tool-changed')).toBe(true);
    const keys = changes().filter((l) => l.startsWith('send-keys'));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((l) => l.includes('body t4'))).toBe(false);
    expect(keys.length).toBeLessThanOrEqual(2);
    expect(ungated()).toEqual([]);
  }, 60_000);

  it('[T4] codex: after the clear → no body, no Enter', async () => {
    addRoster('codex-t4', 'codex');
    const S = nameOf('codex', 'codex-t4');
    addPane(S, 'codex', 'echo PREFILLED');
    onFirst(isKeys(/C-u|BSpace/), () => dropRoster('codex-t4'));
    const sent = captureToolError('codex', 'sendMessage');
    const { status } = await postSend({ content: 'body t4c', cliToolId: 'codex', instanceId: 'codex-t4' }).finally(() => sent.restore());
    expect(status).toBe(500);
    expect(refusedFor(sent.error(), 'target-gone')).toBe(true);
    expect(changes().some((l) => /C-u|BSpace/.test(l))).toBe(true);
    expect(changes().some((l) => l.includes('body t4c') || /Enter$/.test(l))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T5 (F5, R9): OpenCode's dispatch
// ---------------------------------------------------------------------------

describe('T5 (F5, R9): OpenCode prompt_async', () => {
  const instanceId = 'opencode-t5';
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let postAnswer: 'accept' | 'reject' = 'accept';
  beforeEach(() => {
    posts = 0;
    postAnswer = 'accept';
    addRoster(instanceId, 'opencode');
    addPane(nameOf('opencode', instanceId), 'opencode');
    world.frame = (s) => (s === nameOf('opencode', instanceId) ? buildOpencodeComposerFrame() : null);
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4835);
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
    vi.mocked(getOpencodePrimarySession).mockReturnValue('ses_t5');
    globalThis.fetch = fakeFetch((_url, init) => {
      if (init?.method === 'POST') {
        posts += 1;
        return postAnswer === 'accept'
          ? { ok: true, status: 204, headers: new Headers(), json: async () => undefined }
          : { ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ info: { id: 'msg', role: 'user' }, parts: [{ type: 'text', text: 'body t5' }] }),
      };
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('[T5] the row is gone before the dispatch → no POST, the boundary not told, no keyboard, not-sent', async () => {
    onFirst((o) => o.line.startsWith('capture-pane'), () => dropRoster(instanceId));
    const failed = vi.fn();
    const hook = vi.fn();
    let attempt: { state: string } | null = null;
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: 'opencode', resolvedBy: 'roster' });
    const result = await runWithSendTicket(init, () =>
      sendUserMessage(db, {
        worktreeId: WT,
        content: 'body t5',
        cliToolId: 'opencode',
        instanceId,
        inputBoundary: { beforeInput: hook, onDispatchFailed: failed },
        onAttempt: (a) => {
          attempt = a;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(posts).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(changes()).toEqual([]);
    expect((attempt as { state: string } | null)?.state).toBe('not-sent');
  }, 60_000);

  it('[T5] only the port moves (the roster is the same) → no POST, not-sent', async () => {
    let reads = 0;
    vi.mocked(getAssignedOpencodePort).mockImplementation(() => (reads++ === 0 ? 4835 : 4999));
    let attempt: { state: string } | null = null;
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: 'opencode', resolvedBy: 'roster' });
    await runWithSendTicket(init, () =>
      sendUserMessage(db, { worktreeId: WT, content: 'body t5', cliToolId: 'opencode', instanceId, onAttempt: (a) => void (attempt = a) }),
    );
    expect(posts).toBe(0);
    expect(changes()).toEqual([]);
    expect((attempt as { state: string } | null)?.state).toBe('not-sent');
  }, 60_000);

  it('[T5] the POST is rejected, then the row goes before the keyboard fallback → not-sent (the dispatch was settled not_sent)', async () => {
    postAnswer = 'reject';
    world.onCall = (o) => {
      if (o.line.startsWith('POST')) dropRoster(instanceId);
    };
    let attempt: { state: string } | null = null;
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: 'opencode', resolvedBy: 'roster' });
    await runWithSendTicket(init, () =>
      sendUserMessage(db, { worktreeId: WT, content: 'body t5', cliToolId: 'opencode', instanceId, onAttempt: (a) => void (attempt = a) }),
    );
    expect(posts).toBe(1);
    expect(changes()).toEqual([`POST http://127.0.0.1:4835/session/ses_t5/prompt_async`]);
    expect((attempt as { state: string } | null)?.state).toBe('not-sent');
  }, 60_000);

  it('[T5] control: one POST, gated; the boundary told once, as a dispatch', async () => {
    const hook = vi.fn();
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId, cliToolId: 'opencode', resolvedBy: 'roster' });
    const result = await runWithSendTicket(init, () =>
      sendUserMessage(db, { worktreeId: WT, content: 'body t5', cliToolId: 'opencode', instanceId, inputBoundary: { beforeInput: hook } }),
    );
    expect(result.ok).toBe(true);
    expect(posts).toBe(1);
    expect(hook.mock.calls.map((c) => c[1])).toEqual(['dispatch']);
    expect(world.out.filter((o) => o.via === 'fetch' && o.cls === 'change').map((o) => o.permit)).toEqual(['ticketed']);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T8 (I4, R5) and T9 (B2)
// ---------------------------------------------------------------------------

describe('T8 (I4, R5): a matching ticket changes no argv', () => {
  it('[T8] the send service with a launch: the same process calls, in the same order, with and without a ticket', async () => {
    const S = nameOf('codex', 'codex-t8');
    addRoster('codex-t8', 'codex');
    const codex = CLIToolManager.getInstance().getTool('codex');
    const sendOnce = (): Promise<unknown> =>
      codex.startSession(WT, wtPath, 'codex-t8').then(() =>
        sendUserMessage(db, { worktreeId: WT, content: 'same argv', cliToolId: 'codex', instanceId: 'codex-t8' }),
      );
    const init = routeSendTicketInit(db, { worktreeId: WT, instanceId: 'codex-t8', cliToolId: 'codex', resolvedBy: 'roster' });
    await runWithSendTicket(init, () => sendOnce() as Promise<unknown>);
    const ticketed = world.out.map((o) => `${o.via} ${o.line}`);

    world.out.length = 0;
    world.panes.clear();
    resetInstanceInputLocks();
    await sendOnce();
    expect(world.out.map((o) => `${o.via} ${o.line}`)).toEqual(ticketed);
    expect(ticketed.some((l) => l.includes(`new-session -d -s ${S}`))).toBe(true);
  }, 60_000);
});

describe('T9 (B2): the check is at the gate, not after the spawn', () => {
  it('[T9] the roster moves after a key was spawned (before it would apply) → that one key counts as sent', async () => {
    addRoster('claude-t9', 'claude');
    const S = nameOf('claude', 'claude-t9');
    addPane(S, 'claude');
    onFirst(isKeys(/-l -- body t9/), () => setRosterTool('claude-t9', 'codex'));
    await serviceSend('claude', 'claude-t9', 'body t9');
    expect(changes().filter((l) => l.includes('body t9'))).toHaveLength(1);
    expect(permitted().filter((p) => p.startsWith('ticketed:send-keys')).length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
