/**
 * Issue #4534 PR-B s2, T17 (the human's answer C1・C2・C3・Q2 (a)): the public
 * answer of a refusal of the send's own fence, entry by entry.
 *
 * `POST /api/worktrees/:id/send` (the launch, copilot's `/model`, the body,
 * OpenCode's dispatch) and `POST /api/worktrees/:id/terminal` answer 409
 * `{ error, code: "SEND_TARGET_CHANGED", reason, target, current, requestId,
 * sendOutcome }`. `sendOutcome` is `not_sent` only when nothing of the body (nor
 * a dispatch) had started under the request's own ticket, else `unknown`. The
 * attempt is recorded (`lastSend.reason` `target-changed`), and a refused launch
 * sends no start-failure notice. `unreadable` (the check could not read) says
 * the target could not be confirmed — never that it changed; no sentence says
 * that nothing was typed.
 *
 * Every reason the fence gives (`worktree-gone`, `target-gone`, `tool-changed`,
 * `dispatch-changed`, `unreadable`) is put in the way of a real gate on PR-A's
 * footing (`./send-fence-process`), as T16 does.
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
import { resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { stopAllTimers } from '@/lib/timer-manager';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { createRelay, getRelayById } from '@/lib/db/relay-db';
import { handleApiError, ApiError, type ApiErrorPayload } from '@/cli/utils/api-client-errors';
import { postMessage } from '@/cli/commands/message-dispatch';
import type { ApiClient } from '@/cli/utils/api-client';
import { answerSessionStartFailure } from '@/app/api/worktrees/[id]/send/send-session-start';
import { SendTargetChangedError } from '@/lib/session/terminal-fence';
import { resetSessionLaunchFlightsForTest } from '@/lib/session/session-launch-flight';
import { clearCachedClaudePath } from '@/lib/session/claude-session';
import { registerIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT_FRAMES } from '@tests/fixtures/copilot-model-switch-2623';
import { buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';

registerIsolatedAgentHooksDir('fence4534-route');

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

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const WT = 'wt-fence-route';
const WT_WORKER = 'wt-fence-route-worker';
const NOW = Date.now();
let home = '';
let wtPath = '';
let db: Database.Database;
const previousHome = process.env.HOME;

beforeAll(async () => {
  // Nothing here may reach the developer's own home (~/.claude, ~/.codex …).
  home = mkdtempSync(join(tmpdir(), 'fence4534-route-home-'));
  wtPath = mkdtempSync(join(tmpdir(), 'fence4534-route-wt-'));
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
/** Run `action` once, right after the `n`-th call `when` matches. */
function onNth(when: (o: Out) => boolean, n: number, action: () => void): void {
  let seen = 0;
  onFirst((o) => when(o) && ++seen === n, action);
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

const lastSend = (tool: CLIToolType, instanceId: string) => getLastSendAttempt({ worktreeId: WT, cliToolId: tool, instanceId } as never);

// ---------------------------------------------------------------------------
// T17
// ---------------------------------------------------------------------------

type Reason = 'worktree-gone' | 'target-gone' | 'tool-changed' | 'dispatch-changed' | 'unreadable';
type Outcome = 'not_sent' | 'unknown';

/**
 * The sentence the server answers with, written out per reason and outcome (not
 * built the way the server builds it). Q2: `unreadable` never says the target
 * changed; a changed target quotes the refusal (`send target changed: <reason>`).
 */
const SENTENCES: Record<Reason, Record<Outcome, string>> = {
  'worktree-gone': {
    not_sent: 'Send stopped: the target changed while the message was being sent (send target changed: worktree-gone). The message was not delivered; read the roster again, then send it again.',
    unknown: 'Send stopped: the target changed while the message was being sent (send target changed: worktree-gone). The message may already have reached the session; look at the pane before sending it again.',
  },
  'target-gone': {
    not_sent: 'Send stopped: the target changed while the message was being sent (send target changed: target-gone). The message was not delivered; read the roster again, then send it again.',
    unknown: 'Send stopped: the target changed while the message was being sent (send target changed: target-gone). The message may already have reached the session; look at the pane before sending it again.',
  },
  'tool-changed': {
    not_sent: 'Send stopped: the target changed while the message was being sent (send target changed: tool-changed). The message was not delivered; read the roster again, then send it again.',
    unknown: 'Send stopped: the target changed while the message was being sent (send target changed: tool-changed). The message may already have reached the session; look at the pane before sending it again.',
  },
  'dispatch-changed': {
    not_sent: 'Send stopped: the target changed while the message was being sent (send target changed: dispatch-changed). The message was not delivered; read the roster again, then send it again.',
    unknown: 'Send stopped: the target changed while the message was being sent (send target changed: dispatch-changed). The message may already have reached the session; look at the pane before sending it again.',
  },
  unreadable: {
    not_sent: 'Send stopped: the target could not be confirmed while the message was being sent (unreadable). The message was not delivered; read the roster again, then send it again.',
    unknown: 'Send stopped: the target could not be confirmed while the message was being sent (unreadable). The message may already have reached the session; look at the pane before sending it again.',
  },
};
const expectedSentence = (reason: Reason, outcome: Outcome): string => SENTENCES[reason][outcome];

const other = (tool: CLIToolType): CLIToolType => (tool === 'claude' ? 'codex' : 'claude');

/** Put `reason` in the way of the next gate of the send to `instanceId`. */
function perturb(reason: Reason, instanceId: string, tool: CLIToolType): void {
  if (reason === 'worktree-gone') {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(WT);
  } else if (reason === 'target-gone') {
    dropRoster(instanceId);
  } else if (reason === 'tool-changed') {
    setRosterTool(instanceId, other(tool));
  } else if (reason === 'unreadable') {
    // The check's own read throws: the fence cannot confirm the target.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE agent_instances');
  } else {
    // dispatch-changed: OpenCode's port moves under the same roster row.
    let reads = 0;
    vi.mocked(getAssignedOpencodePort).mockImplementation(() => (reads++ === 0 ? 4835 : 4999));
  }
}

const currentFor = (reason: Reason, tool: CLIToolType) =>
  reason === 'tool-changed'
    ? { cliToolId: other(tool), resolvedBy: 'roster' }
    : reason === 'dispatch-changed'
      ? { cliToolId: tool, resolvedBy: 'roster' }
      : null;

const ANSWER_KEYS = ['code', 'current', 'error', 'reason', 'requestId', 'sendOutcome', 'target'];

function expectTargetChanged(
  answer: { status: number; json: Record<string, unknown> },
  row: { reason: Reason; outcome: Outcome; tool: CLIToolType; instanceId: string; extraKeys?: string[] }
): void {
  expect(answer.status).toBe(409);
  expect(Object.keys(answer.json).sort()).toEqual([...ANSWER_KEYS, ...(row.extraKeys ?? [])].sort());
  expect(answer.json.code).toBe('SEND_TARGET_CHANGED');
  expect(answer.json.reason).toBe(row.reason);
  expect(answer.json.sendOutcome).toBe(row.outcome);
  expect(String(answer.json.requestId)).toMatch(/^send-\d+-\d+$/);
  expect(answer.json.target).toEqual({ worktreeId: WT, instanceId: row.instanceId, cliToolId: row.tool });
  expect(answer.json.current).toEqual(currentFor(row.reason, row.tool));
  expect(answer.json.error).toBe(expectedSentence(row.reason, row.outcome));
  expect(String(answer.json.error)).not.toMatch(/nothing was typed/i);
}

/** OpenCode's live server, for the dispatch rows. */
function liveOpencode(instanceId: string): { posts: () => number } {
  const S = nameOf('opencode', instanceId);
  addPane(S, 'opencode');
  world.frame = (s) => (s === S ? buildOpencodeComposerFrame() : null);
  vi.mocked(getAssignedOpencodePort).mockReturnValue(4835);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
  vi.mocked(getOpencodePrimarySession).mockReturnValue('ses_r');
  let posts = 0;
  globalThis.fetch = fakeFetch((_url, init) => {
    if (init?.method === 'POST') posts += 1;
    return init?.method === 'POST'
      ? { ok: true, status: 204, headers: new Headers(), json: async () => undefined }
      : { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ info: { id: 'msg', role: 'user' }, parts: [] }) };
  });
  return { posts: () => posts };
}

const FOUR: Reason[] = ['worktree-gone', 'target-gone', 'tool-changed', 'unreadable'];

describe('T17: 409 SEND_TARGET_CHANGED, entry × reason × state', () => {
  it.each(FOUR)('[T17 start] the launch, %s → 409, not_sent, recorded target-changed, no start-failure notice', async (reason) => {
    const instanceId = 'claude-s';
    addRoster(instanceId, 'claude');
    onFirst((o) => o.line.startsWith('new-session'), () => perturb(reason, instanceId, 'claude'));
    const answer = await post('send', { content: 'body start', cliToolId: 'claude', instanceId });
    expectTargetChanged(answer, { reason, outcome: 'not_sent', tool: 'claude', instanceId });
    expect(lastSend('claude', instanceId)).toMatchObject({ state: 'not-sent', reason: 'target-changed' });
    expect(reportSessionStartFailure).not.toHaveBeenCalled();
  }, 60_000);

  it.each(FOUR)('[T17 model] copilot /model, %s → 409, not_sent, no /model typed', async (reason) => {
    const instanceId = 'copilot-m';
    addRoster(instanceId, 'copilot');
    const S = nameOf('copilot', instanceId);
    addPane(S, 'copilot');
    world.frame = (s) => (s === S ? COPILOT_FRAMES.SWITCH_BEFORE() : null);
    // After the send service's ownership check (the second `#{session_path}` read), before `/model`.
    onNth((o) => o.line.includes('#{session_path}'), 2, () => perturb(reason, instanceId, 'copilot'));
    const answer = await post('send', { content: 'body model', cliToolId: 'copilot', instanceId, model: 'gpt-5.6-terra' });
    expectTargetChanged(answer, { reason, outcome: 'not_sent', tool: 'copilot', instanceId });
    expect(lastSend('copilot', instanceId)).toMatchObject({ state: 'not-sent', reason: 'target-changed' });
    expect(changes().filter((l) => l.includes('/model'))).toEqual([]);
  }, 60_000);

  it.each(FOUR)('[T17 deliver] the body, %s after the clear → 409, not_sent', async (reason) => {
    const instanceId = 'claude-b';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude', 'echo PREFILLED');
    onFirst(isKeys(/C-u/), () => perturb(reason, instanceId, 'claude'));
    const answer = await post('send', { content: 'body deliver', cliToolId: 'claude', instanceId });
    expectTargetChanged(answer, { reason, outcome: 'not_sent', tool: 'claude', instanceId });
    expect(lastSend('claude', instanceId)).toMatchObject({ state: 'not-sent', reason: 'target-changed' });
    expect(changes().some((l) => l.includes('body deliver'))).toBe(false);
  }, 60_000);

  it.each(FOUR)('[T17 deliver] the body, %s after it went in → 409, unknown (it may be on the pane)', async (reason) => {
    const instanceId = 'claude-e';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude');
    onFirst(isKeys(/-l -- body entered/), () => perturb(reason, instanceId, 'claude'));
    const answer = await post('send', { content: 'body entered', cliToolId: 'claude', instanceId });
    expectTargetChanged(answer, { reason, outcome: 'unknown', tool: 'claude', instanceId });
    expect(lastSend('claude', instanceId)).toMatchObject({ state: 'indeterminate', reason: 'target-changed' });
  }, 60_000);

  it.each(['dispatch-changed', 'tool-changed'] as Reason[])('[T17 dispatch] OpenCode prompt_async, %s before the POST → 409, not_sent, no POST', async (reason) => {
    const instanceId = 'opencode-d';
    addRoster(instanceId, 'opencode');
    const server = liveOpencode(instanceId);
    onFirst((o) => o.line.startsWith('capture-pane'), () => perturb(reason, instanceId, 'opencode'));
    const answer = await post('send', { content: 'body dispatch', cliToolId: 'opencode', instanceId });
    expectTargetChanged(answer, { reason, outcome: 'not_sent', tool: 'opencode', instanceId });
    expect(lastSend('opencode', instanceId)).toMatchObject({ state: 'not-sent', reason: 'target-changed' });
    expect(server.posts()).toBe(0);
  }, 60_000);

  it.each(FOUR)('[T17 terminal] /terminal, %s before the keys → 409, not_sent', async (reason) => {
    const instanceId = 'codex-t';
    addRoster(instanceId, 'codex');
    addPane(nameOf('codex', instanceId), 'codex');
    onFirst((o) => o.line.startsWith('capture-pane'), () => perturb(reason, instanceId, 'codex'));
    const answer = await post('terminal', { cliToolId: 'codex', command: 'echo refused', instanceId });
    expectTargetChanged(answer, { reason, outcome: 'not_sent', tool: 'codex', instanceId });
    expect(changes()).toEqual([]);
  }, 60_000);

  it('[T17 terminal] /terminal, the target changes after the command went in → 409, unknown', async () => {
    const instanceId = 'codex-te';
    addRoster(instanceId, 'codex');
    addPane(nameOf('codex', instanceId), 'codex');
    onFirst(isKeys(/-l -- echo typed/), () => perturb('tool-changed', instanceId, 'codex'));
    const answer = await post('terminal', { cliToolId: 'codex', command: 'echo typed', instanceId });
    expectTargetChanged(answer, { reason: 'tool-changed', outcome: 'unknown', tool: 'codex', instanceId });
  }, 60_000);
});

describe('T17 order 1: a driver’s wrap that drops the refusal’s type and cause (the copilot.ts:1084 shape)', () => {
  it('[T17 order-1] the error says only a message; the request’s own ticket refused → still 409, not_sent', async () => {
    const instanceId = 'claude-w';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude', 'echo PREFILLED');
    onFirst(isKeys(/C-u/), () => perturb('tool-changed', instanceId, 'claude'));
    const claude = CLIToolManager.getInstance().getTool('claude') as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = claude.sendMessage.bind(claude);
    const spy = vi.spyOn(claude, 'sendMessage').mockImplementation((...args: unknown[]) =>
      original(...args).catch((error: unknown) => {
        // Only the words survive: no type, no `cause`.
        throw new Error(`Failed to send message to Claude: ${error instanceof Error ? error.message : String(error)}`);
      }),
    );
    try {
      const answer = await post('send', { content: 'body wrapped', cliToolId: 'claude', instanceId });
      expectTargetChanged(answer, { reason: 'tool-changed', outcome: 'not_sent', tool: 'claude', instanceId });
      expect(lastSend('claude', instanceId)).toMatchObject({ state: 'not-sent', reason: 'target-changed' });
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});


// ---------------------------------------------------------------------------
// r2: the rows the reviews asked for
// ---------------------------------------------------------------------------

/** Wrap what `method` of `tool` throws in a bare `Error` (words only: no type, no cause), as the drivers' catches do. */
function wrapWordsOnly(tool: CLIToolType, method: string, prefix: string): () => void {
  const cliTool = CLIToolManager.getInstance().getTool(tool) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cliTool[method].bind(cliTool);
  const spy = vi.spyOn(cliTool, method as never).mockImplementation(((...args: unknown[]) =>
    original(...args).catch((error: unknown) => {
      throw new Error(`${prefix}${error instanceof Error ? error.message : String(error)}`);
    })) as never);
  return () => spy.mockRestore();
}

describe('T17 r2 (P2-1): a launch refused under a driver’s wrap that drops the type and cause', () => {
  it('[T17 start-wrapped] codex.ts:364’s shape around the launch: still 409, not_sent, and no start-failure notice', async () => {
    const instanceId = 'claude-sw';
    addRoster(instanceId, 'claude');
    onFirst((o) => o.line.startsWith('new-session'), () => perturb('tool-changed', instanceId, 'claude'));
    // Below base.ts's catch (startSessionOnce): the error base.ts reads is the wrap.
    const restore = wrapWordsOnly('claude', 'launchSession', 'Failed to start Claude session: ');
    try {
      const answer = await post('send', { content: 'body sw', cliToolId: 'claude', instanceId });
      expectTargetChanged(answer, { reason: 'tool-changed', outcome: 'not_sent', tool: 'claude', instanceId });
      expect(reportSessionStartFailure).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  }, 60_000);
});

/** A bound relay to `instanceId` of WT (the send's target), from the worker worktree. */
function boundRelayTo(instanceId: string): string {
  return createRelay(db, {
    from: { worktreeId: WT_WORKER, instanceId: 'claude' },
    to: { worktreeId: WT, instanceId },
    hops: 1,
    expiresAt: NOW + 86_400_000,
    now: NOW,
    bindMode: 'bound',
  }).id;
}

/** The CLI's end of the server's answer: the exit code, and whether the bound relay was withdrawn. */
async function cliEndOf(answer: { status: number; json: Record<string, unknown> }, relayId: string | undefined): Promise<{ exit: number; withdrew: boolean }> {
  const result = handleApiError(null, answer.status, answer.json as ApiErrorPayload);
  const error = new ApiError(result.message, result.exitCode, answer.status, answer.json as ApiErrorPayload);
  const posts: string[] = [];
  const client = {
    post: vi.fn(async (path: string) => {
      posts.push(path);
      if (path.endsWith('/send')) throw error;
      return {};
    }),
    get: vi.fn(async () => {
      throw new Error('not asked');
    }),
  } as unknown as ApiClient;
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await postMessage(client, WT, { content: 'x' }, {
      relay: relayId ? { id: relayId, bound: true } : undefined,
      promptWaitingFallback: 'waiting',
      target: { target: null, agent: 'claude', instanceId: 'claude' },
    }).catch(() => undefined);
  } finally {
    quiet.mockRestore();
  }
  return { exit: result.exitCode, withdrew: relayId !== undefined && posts.includes(`/api/relays/${relayId}/cancel`) };
}

describe('T17 r2 (P2-2): a bound relay and an ask, answered 409 — relayId, the binding’s sendOutcome, the CLI’s exit', () => {
  it('[T17 relay-bound] refused before the body: relayId, not_sent (the binding agrees), the relay failed; CLI exit 34 and the relay withdrawn', async () => {
    const instanceId = 'claude-rb';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude', 'echo PREFILLED');
    const relayId = boundRelayTo(instanceId);
    onFirst(isKeys(/C-u/), () => perturb('tool-changed', instanceId, 'claude'));
    const answer = await post('send', { content: 'body rb', cliToolId: 'claude', instanceId, relayId });
    expectTargetChanged(answer, { reason: 'tool-changed', outcome: 'not_sent', tool: 'claude', instanceId, extraKeys: ['relayId'] });
    expect(answer.json.relayId).toBe(relayId);
    expect(getRelayById(db, relayId)?.sendState).toBe('failed');
    expect(await cliEndOf(answer, relayId)).toEqual({ exit: 34, withdrew: true });
  }, 60_000);

  it('[T17 relay-bound] refused after the body went in: relayId, unknown (the binding agrees), the relay not failed; CLI exit 99 and the relay kept', async () => {
    const instanceId = 'claude-rbe';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude');
    const relayId = boundRelayTo(instanceId);
    onFirst(isKeys(/-l -- body rbe/), () => perturb('tool-changed', instanceId, 'claude'));
    const answer = await post('send', { content: 'body rbe', cliToolId: 'claude', instanceId, relayId });
    expectTargetChanged(answer, { reason: 'tool-changed', outcome: 'unknown', tool: 'claude', instanceId, extraKeys: ['relayId'] });
    expect(getRelayById(db, relayId)?.sendState).not.toBe('failed');
    expect(await cliEndOf(answer, relayId)).toEqual({ exit: 99, withdrew: false });
  }, 60_000);

  it.each([
    ['C-u', 'not_sent', 'not_sent', 34],
    ['the body', 'unknown', 'send_unknown', 99],
  ] as const)('[T17 ask] refused at %s: the ask’s sendState agrees with sendOutcome %s; CLI exit as the outcome says', async (at, outcome, sendState, exit) => {
    const instanceId = 'claude-ask';
    addRoster(instanceId, 'claude');
    addPane(nameOf('claude', instanceId), 'claude', at === 'C-u' ? 'echo PREFILLED' : '');
    // The ask is attributed only on a claude whose version reads as new enough.
    const execAnswer = world.execAnswer;
    world.execAnswer = (line) => (/\s--version$/.test(line) ? '99.0.0 (Claude Code)' : execAnswer(line));
    // The ask's body goes in with its envelope (typed or pasted): the first change that carries it.
    const bodyWent = (o: Out): boolean => o.cls === 'change' && (o.line.includes('body ask') || o.line.startsWith('paste-buffer'));
    onFirst(at === 'C-u' ? isKeys(/C-u/) : bodyWent, () => perturb('tool-changed', instanceId, 'claude'));
    const answer = await post('send', { content: 'body ask', cliToolId: 'claude', instanceId, ask: { id: outcome === 'not_sent' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', protocol: 1 } });
    expectTargetChanged(answer, { reason: 'tool-changed', outcome, tool: 'claude', instanceId, extraKeys: ['ask'] });
    expect((answer.json.ask as { id: string; sendState: string }).sendState).toBe(sendState);
    expect((await cliEndOf(answer, undefined)).exit).toBe(exit);
  }, 60_000);
});

describe('T17 r2 (a P3-3 / b P3-5): OpenCode, the target changes after a dispatch went out', () => {
  it.each([
    ['no answer (the POST throws: it may have arrived)', 'throw', 'unknown', 'indeterminate'],
    ['refused (400: nothing was created)', 'reject', 'not_sent', 'not-sent'],
  ] as const)('[T17 dispatch-after] the POST got %s, then the keyboard fallback is refused → 409 %s', async (_name, post400, outcome, state) => {
    const instanceId = 'opencode-da';
    addRoster(instanceId, 'opencode');
    const S = nameOf('opencode', instanceId);
    addPane(S, 'opencode');
    world.frame = (s) => (s === S ? buildOpencodeComposerFrame() : null);
    vi.mocked(getAssignedOpencodePort).mockReturnValue(4835);
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'live', lastHeartbeatAt: 1 } as never);
    vi.mocked(getOpencodePrimarySession).mockReturnValue('ses_da');
    let posts = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        perturb('tool-changed', instanceId, 'opencode');
        if (post400 === 'throw') throw new TypeError('fetch failed');
        return { ok: false, status: 400, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) };
      }
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ info: { id: 'msg', role: 'user' }, parts: [] }) };
    }) as unknown as typeof fetch;
    const answer = await post('send', { content: 'body da', cliToolId: 'opencode', instanceId });
    expect(posts).toBe(1);
    expectTargetChanged(answer, { reason: 'tool-changed', outcome, tool: 'opencode', instanceId });
    expect(lastSend('opencode', instanceId)).toMatchObject({ state, reason: 'target-changed' });
  }, 60_000);
});

describe('T17 r2 (a P3-1): the launch records the fence’s state, not always not-sent', () => {
  const cliTool = { id: 'claude', name: 'Claude Code', getSessionName: () => 'mcbd-claude-x' } as never;
  const fenceOf = (state: 'not-sent' | 'indeterminate') => ({
    kind: 'target-changed' as const,
    state,
    order: 1 as const,
    refusal: new SendTargetChangedError('tool-changed', 'send-1-9'),
  });

  it.each([
    ['not-sent', 'not_sent'],
    ['indeterminate', 'unknown'],
  ] as const)('[T17 start-state] a refusal of state %s: recorded so, and the answer says %s', async (state, outcome) => {
    const notSent: string[] = [];
    const attempts: Array<[string, string]> = [];
    const response = await answerSessionStartFailure(
      new SendTargetChangedError('tool-changed', 'send-1-9'),
      {
        cliTool,
        worktreeId: WT,
        instanceId: 'claude',
        recordNotSent: (reason: string) => void notSent.push(reason),
        recordAttempt: (s: string, reason: string) => void attempts.push([s, reason]),
      } as never,
      fenceOf(state),
    );
    const json = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(json.sendOutcome).toBe(outcome);
    if (state === 'not-sent') {
      expect(notSent).toEqual(['target-changed']);
      expect(attempts).toEqual([]);
    } else {
      expect(notSent).toEqual([]);
      expect(attempts).toEqual([['indeterminate', 'target-changed']]);
    }
  });
});

describe('T17 controls: the answers C8 keeps', () => {
  it('[T17-control] a normal send with nothing moving: 201, no code', async () => {
    addRoster('claude-ok', 'claude');
    addPane(nameOf('claude', 'claude-ok'), 'claude');
    const answer = await post('send', { content: 'body ok', cliToolId: 'claude', instanceId: 'claude-ok' });
    expect(answer.status).toBe(201);
    expect(answer.json.code).toBeUndefined();
  }, 60_000);
});
