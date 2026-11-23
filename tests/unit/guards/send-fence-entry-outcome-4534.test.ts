/**
 * Issue #4534 PR-B s1, T16 (design v2 §3.2, the entries' table): at every entry
 * a refusal of the fence reaches ONE classification, and the entry's internal
 * result carries its kind (`target-changed`) and state (`not-sent` /
 * `indeterminate`). The same runs fix the public answers as they are today —
 * status, code, the fields of the body, `lastSend.reason`, the timer's text:
 * this step changes none of them (they wait for the human's answer, step 2).
 *
 * The entries: the launch (`send-session-start.ts`), copilot's `/model`, the
 * body, OpenCode's dispatch, the relay delivery (`relay-delivery.ts`
 * `settleUnsentResult`), `/terminal`, the timer.
 *
 * The footing is PR-A's (`./send-fence-process`, as the boundary and refusal
 * tables use it): real from the entry down — the routes, the relay pump, the
 * timer manager, the fence, the send service, the drivers, `tmux.ts`; fake:
 * the process boundary, `fetch`, and reads nothing here judges. The refusal is
 * put in the way of a gate by changing the roster (or the timer's row) right
 * after a process call, so each gate refuses exactly as it would in use.
 *
 * Before the fix there is no classification to report, so every outcome row is
 * red by assertion; the public values are green on both sides.
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
import { createRelay, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import type { Worktree } from '@/types/models';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { addPane, changes, fakeFetch, gateObserver, resetWorld, world, type Out } from './send-fence-process';
import { resetFenceForTests, setFenceObserver } from '@/lib/session/terminal-fence';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { clearSendAttempts, getLastSendAttempt } from '@/lib/session/send-attempt-state';
import { reportSessionStartFailure } from '@/lib/cli-tools/start-availability';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { getOpencodeLiveness, getOpencodePrimarySession } from '@/lib/hooks/sources/opencode/subscription';
import { pumpRelayDeliveries, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { getActiveTimerCount, scheduleTimer, stopAllTimers } from '@/lib/timer-manager';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT_FRAMES } from '@tests/fixtures/copilot-model-switch-2623';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

registerIsolatedAgentHooksDir('fence4534-outcome');

// ---------------------------------------------------------------------------
// The outcome the entries report (the classification module, loaded at run time)
// ---------------------------------------------------------------------------

interface OutcomeEvent {
  entry: 'start' | 'model' | 'deliver' | 'relay' | 'terminal' | 'timer';
  outcome: { kind: string; state: string; order: number; refusal: unknown };
  settled?: string;
}
interface OutcomeModule {
  setSendFenceOutcomeObserver: (observer: ((event: OutcomeEvent) => void) | null) => void;
}
const OUTCOME_MODULE = '@/lib/session/send-fence-outcome';
let events: OutcomeEvent[] = [];
let outcomeModule: OutcomeModule | null = null;

/** The events of `entry`, as `{ kind, state, settled }` (the refusal's reason added). */
const outcomesOf = (entry: OutcomeEvent['entry']) =>
  events
    .filter((e) => e.entry === entry)
    .map((e) => ({
      kind: e.outcome.kind,
      state: e.outcome.state,
      reason: (e.outcome.refusal as { reason?: unknown } | null)?.reason,
      ...(e.settled !== undefined ? { settled: e.settled } : {}),
    }));

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const WT = 'wt-fence-outcome';
const WT_WORKER = 'wt-fence-outcome-worker';
const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
let home = '';
let wtPath = '';
let db: Database.Database;
const previousHome = process.env.HOME;

beforeAll(async () => {
  // Nothing here may reach the developer's own home (~/.claude, ~/.codex …).
  home = mkdtempSync(join(tmpdir(), 'fence4534-outcome-home-'));
  wtPath = mkdtempSync(join(tmpdir(), 'fence4534-outcome-wt-'));
  process.env.HOME = home;
  try {
    outcomeModule = (await import(/* @vite-ignore */ OUTCOME_MODULE)) as OutcomeModule;
  } catch {
    outcomeModule = null;
  }
});
afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  resetWorld();
  world.path = wtPath;
  resetFenceForTests();
  resetInstanceInputLocks();
  resetRelayDeliveryState();
  resetSessionLaunchFlightsForTest();
  clearSendAttempts();
  clearCachedClaudePath();
  setFenceObserver(gateObserver);
  vi.mocked(reportSessionStartFailure).mockClear();
  vi.mocked(getAssignedOpencodePort).mockReturnValue(null);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'absent' } as never);
  vi.mocked(getOpencodePrimarySession).mockReturnValue(null);
  events = [];
  outcomeModule?.setSendFenceOutcomeObserver((event) => events.push(event));
  db = new Database(':memory:');
  runMigrations(db);
  const instance = (await import('@/lib/db/db-instance')) as unknown as { setTestDb: (d: unknown) => void };
  instance.setTestDb(db);
  for (const [id, path] of [[WT, wtPath], [WT_WORKER, `${wtPath}-worker`]] as const) {
    upsertWorktree(db, { id, name: id, path, repositoryPath: wtPath, repositoryName: 'repo', cliToolId: 'claude' } as Worktree);
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  outcomeModule?.setSendFenceOutcomeObserver(null);
  setFenceObserver(null);
  stopAllTimers();
  resetRelayDeliveryState();
  db.close();
});

const nameOf = (tool: CLIToolType, instanceId?: string): string => resolveSessionName(tool, WT, instanceId);

function addRoster(instanceId: string, tool: CLIToolType): void {
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at) VALUES (?, ?, ?, '', 0, ?)`,
  ).run(WT, instanceId, tool, NOW);
}
function setRosterTool(instanceId: string, tool: CLIToolType): void {
  db.prepare(`UPDATE agent_instances SET cli_tool_id = ? WHERE worktree_id = ? AND instance_id = ?`).run(tool, WT, instanceId);
}
function dropRoster(instanceId: string): void {
  db.prepare(`DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?`).run(WT, instanceId);
}

/** Run `action` once, right after the first call `when` matches. */
function onFirst(when: (o: Out) => boolean, action: () => void): void {
  let done = false;
  const inner = world.onCall;
  world.onCall = (o) => {
    inner(o);
    if (!done && when(o)) {
      done = true;
      action();
    }
  };
}
const isKeys = (pattern: RegExp) => (o: Out): boolean => o.line.startsWith('send-keys') && pattern.test(o.line);

async function post(kind: 'send' | 'terminal', body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = kind === 'send' ? await import('@/app/api/worktrees/[id]/send/route') : await import('@/app/api/worktrees/[id]/terminal/route');
  const request = new Request(`http://localhost:3000/api/worktrees/${WT}/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = (await POST(request as unknown as NextRequest, { params: Promise.resolve({ id: WT }) })) as Response;
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** What the tool's method threw (a spy that calls through). */
function captureToolError(tool: CLIToolType, method: 'sendMessage' | 'startSession'): { error: () => unknown; restore: () => void } {
  const cliTool = CLIToolManager.getInstance().getTool(tool) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cliTool[method].bind(cliTool);
  let caught: unknown = undefined;
  const spy = vi.spyOn(cliTool, method).mockImplementation((...args: unknown[]) =>
    original(...args).catch((error: unknown) => {
      caught ??= error;
      throw error;
    }),
  );
  return { error: () => caught, restore: () => spy.mockRestore() };
}

const lastSend = (tool: CLIToolType, instanceId: string) => getLastSendAttempt({ worktreeId: WT, cliToolId: tool, instanceId } as never);

// ---------------------------------------------------------------------------
// T16
// ---------------------------------------------------------------------------

describe('T16: each entry’s internal result carries the kind and the state; its public answer is today’s', () => {
  it('[T16] the module that reports the outcomes exists', () => {
    expect(outcomeModule, 'send-fence-outcome (setSendFenceOutcomeObserver)').not.toBeNull();
  });

  it('[T16 start] the launch (send-session-start): target-changed, not-sent; 500 with no code, session-start-failed; no start-failure notice', async () => {
    addRoster('claude-s', 'claude');
    onFirst((o) => o.line.startsWith('new-session'), () => dropRoster('claude-s'));
    const { status, json } = await post('send', { content: 'body start', cliToolId: 'claude', instanceId: 'claude-s' });
    // Today's answer, byte for byte in its fields.
    expect(status).toBe(500);
    expect(Object.keys(json).sort()).toEqual(['error', 'sendOutcome']);
    expect(json.error).toBe('Failed to start Claude Code session: send target changed: target-gone');
    expect(json.sendOutcome).toBe('not_sent');
    expect(lastSend('claude', 'claude-s')).toMatchObject({ state: 'not-sent', reason: 'session-start-failed' });
    expect(reportSessionStartFailure).not.toHaveBeenCalled();
    // The internal result.
    expect(outcomesOf('start')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'target-gone' }]);
  }, 60_000);

  it('[T16 model] copilot’s /model: target-changed, not-sent; today’s 500 and model-switch-failed', async () => {
    const instanceId = 'copilot-m';
    addRoster(instanceId, 'copilot');
    const S = nameOf('copilot', instanceId);
    addPane(S, 'copilot');
    world.frame = (s) => (s === S ? COPILOT_FRAMES.SWITCH_BEFORE() : null);
    // After every read the route makes before its ticket, the copilot instance runs claude.
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool(instanceId, 'claude'));
    const { status, json } = await post('send', { content: 'body model', cliToolId: 'copilot', instanceId, model: 'gpt-5.6-terra' });
    expect(status).toBe(500);
    expect(Object.keys(json).sort()).toEqual(['error', 'sendOutcome']);
    expect(String(json.error)).toMatch(/^Failed to switch model to gpt-5\.6-terra: /);
    expect(json.sendOutcome).toBe('not_sent');
    expect(lastSend('copilot', instanceId)).toMatchObject({ state: 'not-sent', reason: 'model-switch-failed' });
    expect(changes().filter((l) => l.includes('/model'))).toEqual([]);
    expect(outcomesOf('model')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'tool-changed' }]);
  }, 60_000);

  it('[T16 deliver] the body, refused before it went in (after the clear): target-changed, not-sent; today’s 500, send-error', async () => {
    addRoster('claude-b', 'claude');
    addPane(nameOf('claude', 'claude-b'), 'claude', 'echo PREFILLED');
    onFirst(isKeys(/C-u/), () => setRosterTool('claude-b', 'codex'));
    const { status, json } = await post('send', { content: 'body deliver', cliToolId: 'claude', instanceId: 'claude-b' });
    expect(status).toBe(500);
    expect(Object.keys(json).sort()).toEqual(['error', 'sendOutcome']);
    expect(String(json.error)).toMatch(/^Failed to send message to .*send target changed: tool-changed/);
    expect(json.sendOutcome).toBe('not_sent');
    expect(lastSend('claude', 'claude-b')).toMatchObject({ state: 'not-sent', reason: 'send-error' });
    expect(changes().some((l) => l.includes('body deliver'))).toBe(false);
    expect(outcomesOf('deliver')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'tool-changed' }]);
  }, 60_000);

  it('[T16 deliver] the body, refused after it went in (at the Enter): target-changed, indeterminate; today’s 500, unknown', async () => {
    addRoster('claude-e', 'claude');
    addPane(nameOf('claude', 'claude-e'), 'claude');
    onFirst(isKeys(/-l -- body entered/), () => setRosterTool('claude-e', 'codex'));
    const { status, json } = await post('send', { content: 'body entered', cliToolId: 'claude', instanceId: 'claude-e' });
    expect(status).toBe(500);
    expect(Object.keys(json).sort()).toEqual(['error', 'sendOutcome']);
    expect(json.sendOutcome).toBe('unknown');
    expect(lastSend('claude', 'claude-e')).toMatchObject({ state: 'indeterminate', reason: 'send-error' });
    expect(outcomesOf('deliver')).toEqual([{ kind: 'target-changed', state: 'indeterminate', reason: 'tool-changed' }]);
  }, 60_000);

  it('[T16 dispatch] OpenCode’s prompt_async, refused before the POST: target-changed, not-sent; no POST; today’s 500, send-error', async () => {
    const instanceId = 'opencode-d';
    addRoster(instanceId, 'opencode');
    const S = nameOf('opencode', instanceId);
    addPane(S, 'opencode');
    world.frame = (s) => (s === S ? buildOpencodeComposerFrame() : null);
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4835);
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
    vi.mocked(getOpencodePrimarySession).mockReturnValue('ses_d');
    let posts = 0;
    globalThis.fetch = fakeFetch((_url, init) => {
      if (init?.method === 'POST') posts += 1;
      return init?.method === 'POST'
        ? { ok: true, status: 204, headers: new Headers(), json: async () => undefined }
        : { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ info: { id: 'msg', role: 'user' }, parts: [] }) };
    });
    onFirst((o) => o.line.startsWith('capture-pane'), () => dropRoster(instanceId));
    const { status, json } = await post('send', { content: 'body dispatch', cliToolId: 'opencode', instanceId });
    expect(status).toBe(500);
    expect(Object.keys(json).sort()).toEqual(['error', 'sendOutcome']);
    expect(json.sendOutcome).toBe('not_sent');
    expect(lastSend('opencode', instanceId)).toMatchObject({ state: 'not-sent', reason: 'send-error' });
    expect(posts).toBe(0);
    expect(outcomesOf('deliver')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'target-gone' }]);
  }, 60_000);

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
  const deliveryState = (relayId: string): string | null =>
    (db.prepare('SELECT delivery_state FROM session_relays WHERE id = ?').get(relayId) as { delivery_state: string | null }).delivery_state;

  it('[T16 relay] refused before the body: target-changed, not-sent, the payload goes back (settleUnsentResult: failed)', async () => {
    addRoster('claude-r', 'claude');
    addPane(nameOf('claude', 'claude-r'), 'claude');
    const relayId = openRelayWithReply('claude-r');
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool('claude-r', 'codex'));
    await pumpRelayDeliveries();
    expect(changes()).toEqual([]);
    // Today's settlement: the reply waits again, not held.
    expect(getRelayPendingPayload(db, relayId)?.body).toBe('relay reply body');
    expect(deliveryState(relayId)).toBeNull();
    expect(outcomesOf('relay')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'tool-changed', settled: 'failed' }]);
  }, 60_000);

  it('[T16 relay] refused after the body went in: target-changed, indeterminate, held (settleUnsentResult: uncertain)', async () => {
    addRoster('claude-ri', 'claude');
    addPane(nameOf('claude', 'claude-ri'), 'claude');
    const relayId = openRelayWithReply('claude-ri');
    onFirst(isKeys(/-l -- relay reply body/), () => setRosterTool('claude-ri', 'codex'));
    await pumpRelayDeliveries();
    expect(deliveryState(relayId)).not.toBeNull();
    expect(outcomesOf('relay')).toEqual([{ kind: 'target-changed', state: 'indeterminate', reason: 'tool-changed', settled: 'uncertain' }]);
  }, 60_000);

  it('[T16 terminal] /terminal: target-changed, not-sent; today’s 500 and its fixed text, nothing else in the body', async () => {
    addRoster('codex-t', 'codex');
    addPane(nameOf('codex', 'codex-t'), 'codex');
    onFirst((o) => o.line.startsWith('capture-pane'), () => setRosterTool('codex-t', 'claude'));
    const { status, json } = await post('terminal', { cliToolId: 'codex', command: 'echo refused', instanceId: 'codex-t' });
    expect(status).toBe(500);
    expect(json).toEqual({ error: 'Failed to send command to terminal' });
    expect(changes()).toEqual([]);
    expect(outcomesOf('terminal')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'tool-changed' }]);
  }, 60_000);

  it('[T16 timer] the timer: target-changed, not-sent; its row failed with today’s text `[send] <the error>`', async () => {
    const S = nameOf('claude');
    addPane(S, 'claude');
    const sending = (): boolean => (db.prepare(`SELECT COUNT(*) AS n FROM timer_messages WHERE status = 'sending'`).get() as { n: number }).n > 0;
    onFirst((o) => o.line.startsWith('capture-pane') && sending(), () => {
      db.prepare(`UPDATE timer_messages SET status = 'cancelled' WHERE status = 'sending'`).run();
    });
    const sent = captureToolError('claude', 'sendMessage');
    const timer = createTimer(db, { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', message: 'timer body', delayMs: 0 });
    try {
      scheduleTimer(timer.id, WT, 0);
      await vi.waitFor(
        () => {
          if (getActiveTimerCount() > 0) throw new Error('timer still running');
        },
        { timeout: 20_000, interval: 20 },
      );
    } finally {
      sent.restore();
    }
    expect(changes()).toEqual([]);
    const row = getTimerById(db, timer.id);
    expect(row?.error).toBe(`[send] ${(sent.error() as Error).message}`);
    expect(outcomesOf('timer')).toEqual([{ kind: 'target-changed', state: 'not-sent', reason: 'target-gone' }]);
  }, 60_000);
});
