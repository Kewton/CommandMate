/**
 * Issue #3798: with no browser open, agy's waiting episode never closed.
 *
 * The episode is opened by the response poller's prompt branch and was closed
 * only by the status probe (a browser) or by the response poller recording a
 * reply — which agy never gives, its reply arrives on a hook. The Auto-Yes
 * hold's re-ask found the answered wait still open (`prompt-push-allowed
 * (auto-yes-not-answered)`), and the next prompt was folded into the stale
 * `waitingSince` and allowed at once.
 *
 * Now the turn transition closes the wait of the turn it ended, in the same
 * synchronous step that records the delivery
 * (`docs/design/issue-3798-waiting-episode.md` §2.4 T table, §2.5). These cases
 * drive the real `POST /api/hooks/agent-event` with agy's actual event set —
 * `session_start`, `post_tool_use`, `stop`, no `user_prompt_submit`: a turn
 * opens on its first `post_tool_use` — and the real push path (only `web-push`
 * is stubbed). The response poller's prompt branch is reproduced in its order:
 * the gate with the open episode's `since`, then the edge.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** The await `route.ts:177` makes after recording a stop, held when a case asks. */
const stopCapture = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('@/lib/hooks/stop-history-capture', () => ({
  resolveStopTranscriptCapture: vi.fn(async () => {
    if (stopCapture.gate) await stopCapture.gate;
    return { status: 'unavailable', settled: Promise.resolve(false) };
  }),
}));

const infoLines = vi.hoisted(() => [] as Array<{ event: string; context: Record<string, unknown> }>);
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: (event: string, context: Record<string, unknown> = {}) => {
        infoLines.push({ event, context });
      },
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { upsertPushSubscription } from '@/lib/db';
import { buildCompositeKey, clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import type { AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getAgentTurn,
  isAwaitingInstruction,
  joinOpenTurnFromDuplicate,
  observeScraperCompletionEvidence,
  recordAgentEvent,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { AUTO_YES_ANSWER_GRACE_MS, clearAutoYesHolds, decideAndLogPromptPush } from '@/lib/push/prompt-push-gate';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import { pendingEscalationCount, startWaitingPushNotifier, stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisode,
  getWaitingEpisodeRecord,
  observeWaitingEdge,
  onWaitingEpisodeTransition,
  onWaitingTransition,
  openEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';
import { POST as postAgentEventRoute } from '@/app/api/hooks/agent-event/route';

const WT = 'wt-3798-agy';
const TOOL = 'antigravity' as const;
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
/** The UAT's first run: the episode opened at 09:28:14.804. */
const T0 = 1_792_315_694_804;

let savedEnv: Record<string, string | undefined>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function promptPushes(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string) as Record<string, unknown>)
    .filter((p) => p.kind === 'prompt' && p.resolved !== true);
}

function allowedLines(): Array<Record<string, unknown>> {
  return infoLines.filter((l) => l.event === 'prompt-push-allowed').map((l) => l.context);
}

/** The Auto-Yes poller's last answer, as it keeps it on `globalThis`. */
function pollerAnsweredAt(at: number | null): void {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const key = buildCompositeKey(WT, TOOL);
  if (at === null) states.delete(key);
  else states.set(key, { lastServerResponseTimestamp: at } as AutoYesPollerState);
}

/** The response poller's prompt branch (`savePromptMessage`), in its order. */
function responseCheckerSeesPrompt(now = Date.now()): { since: number; suppress: boolean; reason: string } {
  const since = getWaitingEpisode(WT, TOOL)?.since ?? now;
  const decision = decideAndLogPromptPush({ worktreeId: WT, cliToolId: TOOL, waitingSince: since, now });
  observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt', now });
  return { since, suppress: decision.suppress, reason: decision.reason };
}

/** agy's hook, as `scripts/hooks/cmate-agent-event.sh` posts it. */
async function agyHook(event: 'post_tool_use' | 'stop' | 'session_start', conversationId = CONVERSATION) {
  const search = new URLSearchParams({ worktreeId: WT, instanceId: TOOL }).toString();
  const response = await postAgentEventRoute(
    new Request(`http://localhost/api/hooks/agent-event?${search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: TOOL, event, cwd: join(tmpdir(), '.gemini', 'config'), sessionId: conversationId }),
    }) as unknown as NextRequest
  );
  expect(response.status).toBe(202);
}

/** One delivery straight into the state, as `applyAgentEventToState` records it. */
function hook(
  event: AgentEventType,
  options: { sessionId?: string | null; tool?: 'antigravity' | 'claude'; detail?: string | null; extra?: Record<string, unknown> } = {}
) {
  const tool = options.tool ?? TOOL;
  return recordAgentEvent(WT, tool, tool, {
    event,
    at: Date.now(),
    detail: options.detail ?? null,
    sessionId: options.sessionId ?? null,
    ...options.extra,
  });
}

/** The answer, then a pause long enough that the next hook is not a duplicate. */
async function pollerAnswers(afterMs = 315): Promise<void> {
  await vi.advanceTimersByTimeAsync(afterMs);
  pollerAnsweredAt(Date.now());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'uat-agyfresh', join(tmpdir(), 'wt-3798'), join(tmpdir(), 'repo-3798'), 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  infoLines.length = 0;
  stopCapture.gate = null;

  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingPushNotifier();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearAutoYesHolds();
  pollerAnsweredAt(null);
  clearAgentStopEvents();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
  setAutoYesEnabled(WT, TOOL, true);
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearAutoYesHolds();
  pollerAnsweredAt(null);
  clearAgentStopEvents();
  stopCapture.gate = null;
  vi.useRealTimers();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** One agy turn that finished before this test's wait: P, closed by its stop. */
async function previousTurn(): Promise<string> {
  await agyHook('post_tool_use');
  await vi.advanceTimersByTimeAsync(4_000);
  await agyHook('stop');
  await vi.advanceTimersByTimeAsync(60_000);
  return getAgentTurn(WT, TOOL, TOOL)!.turnId;
}

describe('[#3798] agy: the end of turn closes the wait, browser or not', () => {
  it('agy: confirmation → answer → post_tool_use → stop closes the wait (no prompt-push-allowed at hold end)', async () => {
    const p = await previousTurn();
    expect(responseCheckerSeesPrompt()).toMatchObject({ suppress: true, reason: 'auto-yes-answering' });
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding).toMatchObject({ kind: 'unattributed', lastClosedTurnId: p });
    await flush();

    await pollerAnswers();
    await vi.advanceTimersByTimeAsync(500);
    await agyHook('post_tool_use');
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('turn');
    await vi.advanceTimersByTimeAsync(3_200);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(allowedLines()).toEqual([]);
    expect(promptPushes()).toEqual([]);
    expect(pendingEscalationCount()).toBe(0);
  });

  it('agy: confirmation → answer → stop without post_tool_use closes the wait', async () => {
    await previousTurn();
    responseCheckerSeesPrompt();
    await flush();
    await pollerAnswers();
    await vi.advanceTimersByTimeAsync(3_720);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    expect(infoLines.find((l) => l.event === 'waiting-episode-closed-by-turn')?.context).toMatchObject({
      outcome: 'stop-without-turn',
      reason: 'turn-stop',
    });

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(allowedLines()).toEqual([]);
  });

  it('agy: first turn (no previous turn) closes the wait in both orders', async () => {
    // post_tool_use, then stop.
    responseCheckerSeesPrompt();
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding).toMatchObject({ kind: 'unattributed', lastClosedTurnId: null });
    await pollerAnswers();
    await agyHook('post_tool_use');
    await vi.advanceTimersByTimeAsync(3_000);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();

    // A fresh instance: no turn at all, then a stop alone.
    clearAgentStopEvents();
    clearWaitingEpisodes();
    await vi.advanceTimersByTimeAsync(60_000);
    responseCheckerSeesPrompt();
    await pollerAnswers();
    await vi.advanceTimersByTimeAsync(3_000);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('stop after scraper_evidence closed the turn closes turn(T) and unattributed(lastClosed=T)', async () => {
    // turn(T): the wait opened inside the turn.
    await agyHook('post_tool_use');
    const t = getAgentTurn(WT, TOOL, TOOL)!.turnId;
    responseCheckerSeesPrompt();
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding).toMatchObject({ kind: 'turn', turnId: t });
    for (let i = 0; i < 3; i++) observeScraperCompletionEvidence(WT, TOOL, TOOL, true);
    expect(getAgentTurn(WT, TOOL, TOOL)?.closedBy).toBe('scraper_evidence');
    await vi.advanceTimersByTimeAsync(4_000);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();

    // unattributed(lastClosed=T2): the wait opened after the screen closed T2.
    await vi.advanceTimersByTimeAsync(60_000);
    await agyHook('post_tool_use');
    const t2 = getAgentTurn(WT, TOOL, TOOL)!.turnId;
    for (let i = 0; i < 3; i++) observeScraperCompletionEvidence(WT, TOOL, TOOL, true);
    responseCheckerSeesPrompt();
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding).toMatchObject({ kind: 'unattributed', lastClosedTurnId: t2 });
    await vi.advanceTimersByTimeAsync(4_000);
    await agyHook('stop');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });
});

describe('[#3798] what a stop closes, and what it does not', () => {
  it("#1: old session A stop while session B waits leaves B (id, since, hold end, push count)", async () => {
    await agyHook('post_tool_use', 'session-B');
    responseCheckerSeesPrompt();
    const before = getWaitingEpisodeRecord(WT, TOOL)!;
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    await agyHook('stop', 'session-A');
    const after = getWaitingEpisodeRecord(WT, TOOL)!;
    expect(after.episodeId).toBe(before.episodeId);
    expect(after.since).toBe(T0);

    // Nobody answered B's screen: the hold runs out as for any person's wait.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS);
    await flush();
    expect(allowedLines()).toEqual([expect.objectContaining({ reason: 'auto-yes-not-answered', waitingSince: T0 })]);
    expect(promptPushes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await agyHook('stop', 'session-B');
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('#3/#7: stop recorded, await held, B opens / generation bumps — B survives the late return', async () => {
    // #3: B's wait opens while A's stop is parked on `route.ts:177`.
    await agyHook('post_tool_use');
    responseCheckerSeesPrompt();
    let release!: () => void;
    stopCapture.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    const parked = agyHook('stop');
    await flush();
    expect(getWaitingEpisode(WT, TOOL)).toBeNull(); // A's wait closed when the stop was recorded

    await vi.advanceTimersByTimeAsync(10_000);
    const bAt = Date.now();
    responseCheckerSeesPrompt(bAt);
    const b = getWaitingEpisodeRecord(WT, TOOL)!;
    release();
    await parked;
    expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b.episodeId);
    expect(getWaitingEpisode(WT, TOOL)?.since).toBe(bAt);

    // #7: a stop parked, a new generation, B waiting before its first hook.
    stopCapture.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const parked2 = agyHook('stop');
    await flush();
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    beginAgentEventGeneration(WT, TOOL, TOOL, Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    responseCheckerSeesPrompt();
    const b2 = getWaitingEpisodeRecord(WT, TOOL)!;
    release();
    await parked2;
    expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b2.episodeId);
  });

  it('rejected stop (other session / before generation) changes nothing', async () => {
    await agyHook('post_tool_use', 'session-B');
    responseCheckerSeesPrompt();
    const opened = getWaitingEpisodeRecord(WT, TOOL)!;
    await vi.advanceTimersByTimeAsync(4_000);
    await agyHook('stop', 'session-A');

    // A stop stamped before the current generation.
    beginAgentEventGeneration(WT, TOOL, TOOL, Date.now());
    responseCheckerSeesPrompt();
    const inNewGeneration = getWaitingEpisodeRecord(WT, TOOL)!;
    expect(inNewGeneration.episodeId).not.toBe(opened.episodeId); // the fence closed the old one
    recordAgentEvent(WT, TOOL, TOOL, { event: 'stop', at: Date.now() - 5_000, detail: null, sessionId: null });
    expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(inNewGeneration.episodeId);
  });

  it('same-millisecond stop and turn start give two turn ids and two episodes', async () => {
    await agyHook('post_tool_use');
    const a = getAgentTurn(WT, TOOL, TOOL)!.turnId;
    responseCheckerSeesPrompt();
    const first = getWaitingEpisodeRecord(WT, TOOL)!;
    await vi.advanceTimersByTimeAsync(4_000);
    // The stop and the next turn's first tool call in the same millisecond.
    hook('stop', { sessionId: CONVERSATION });
    hook('post_tool_use', { sessionId: CONVERSATION });
    const b = getAgentTurn(WT, TOOL, TOOL)!.turnId;
    expect(b).not.toBe(a);
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    responseCheckerSeesPrompt();
    const second = getWaitingEpisodeRecord(WT, TOOL)!;
    expect(second.episodeId).not.toBe(first.episodeId);
    expect(second.since).toBe(first.since + 4_000);
    expect(second.binding).toMatchObject({ kind: 'turn', turnId: b });
  });

  it('user_prompt_submit closes a leftover unattributed wait', () => {
    hook('stop', { tool: 'claude', sessionId: 's' });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    expect(getWaitingEpisodeRecord(WT, 'claude')?.binding.kind).toBe('unattributed');
    vi.setSystemTime(Date.now() + 4_000);
    hook('user_prompt_submit', { tool: 'claude', sessionId: 's' });
    expect(getWaitingEpisode(WT, 'claude')).toBeNull();
  });

  it('the closing listener reads the turn model after applyAwaitingInstructionTransition', () => {
    hook('user_prompt_submit', { tool: 'claude', sessionId: 's' });
    // The agent sitting at its composer inside the turn: "awaiting instruction".
    hook('notification', { tool: 'claude', sessionId: 's', detail: 'idle_prompt' });
    expect(isAwaitingInstruction(WT, 'claude', 'claude')).toBe(true);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    const seen: Array<{ closedBy: string | null | undefined; awaiting: boolean }> = [];
    onWaitingTransition((t) => {
      if (t.waiting) return;
      seen.push({
        closedBy: getAgentTurn(WT, 'claude', 'claude')?.closedBy,
        awaiting: isAwaitingInstruction(WT, 'claude', 'claude'),
      });
    });
    vi.setSystemTime(Date.now() + 4_000);
    // `session_end` ends the turn and clears "awaiting instruction"; the edge
    // fires after both, so its listener sees neither half-done.
    hook('session_end', { tool: 'claude', sessionId: 's' });
    expect(seen).toEqual([{ closedBy: 'session_end', awaiting: false }]);
  });
});

describe('[#3798] decisions, restores and generations', () => {
  it('claude parallel tools: tool A post_tool_use leaves tool B wait; permission_replied closes it', () => {
    hook('user_prompt_submit', { tool: 'claude', sessionId: 's' });
    hook('pre_tool_use', { tool: 'claude', sessionId: 's', detail: 'Bash' });
    // Tool B's dialog, inside the turn.
    hook('notification', { tool: 'claude', sessionId: 's', detail: 'permission_prompt', extra: { decisionId: 'd-b' } });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    const opened = getWaitingEpisodeRecord(WT, 'claude')!;
    expect(opened.binding.kind).toBe('turn');

    vi.setSystemTime(Date.now() + 1_000);
    hook('post_tool_use', { tool: 'claude', sessionId: 's', detail: 'Read' }); // tool A finished
    expect(getWaitingEpisodeRecord(WT, 'claude')).toMatchObject({ episodeId: opened.episodeId, since: opened.since });

    vi.setSystemTime(Date.now() + 1_000);
    hook('notification', {
      tool: 'claude',
      sessionId: 's',
      detail: 'permission_replied',
      extra: { decisionId: 'd-b', promptSettled: true },
    });
    // The bulk release of A already emptied the record, so the answer finds nothing to settle.
    // The wait still ends with the turn.
    vi.setSystemTime(Date.now() + 1_000);
    hook('stop', { tool: 'claude', sessionId: 's' });
    expect(getWaitingEpisode(WT, 'claude')).toBeNull();
  });

  it('an explicit answer that leaves nothing pending closes the wait (decision-settled)', () => {
    hook('notification', { tool: 'claude', sessionId: 's', detail: 'permission_prompt', extra: { decisionId: 'd-1' } });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    expect(getWaitingEpisodeRecord(WT, 'claude')?.binding.kind).toBe('dialog-only');
    hook('notification', {
      tool: 'claude',
      sessionId: 's',
      detail: 'permission_replied',
      extra: { decisionId: 'd-1', promptSettled: true },
    });
    expect(getWaitingEpisode(WT, 'claude')).toBeNull();
  });

  it('predicted decision expired after 20s: post_tool_use rebinds, stop closes', () => {
    reportPermissionRequestPending(WT, TOOL, TOOL, 'Bash');
    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
    const opened = getWaitingEpisodeRecord(WT, TOOL)!;
    expect(opened.binding.kind).toBe('dialog-only');

    vi.setSystemTime(Date.now() + 21_000);
    hook('post_tool_use', { sessionId: CONVERSATION });
    expect(getWaitingEpisodeRecord(WT, TOOL)).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'turn' } });

    vi.setSystemTime(Date.now() + 4_000);
    hook('stop', { sessionId: CONVERSATION });
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();

    // A forecast that expired, then a stop with no turn: T11's D.
    reportPermissionRequestPending(WT, TOOL, TOOL, 'Bash');
    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('dialog-only');
    vi.setSystemTime(Date.now() + 21_000);
    hook('stop', { sessionId: CONVERSATION });
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('a forecast reported after the wait opened makes it dialog-only (decision-opened)', () => {
    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('unattributed');
    reportPermissionRequestPending(WT, TOOL, TOOL, 'Bash');
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('dialog-only');
  });

  it('interrupt resend closes P\'s wait; queued-notice restore rebinds N\'s wait to R', () => {
    hook('user_prompt_submit', { tool: 'claude', sessionId: 's' });
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    vi.setSystemTime(Date.now() + 4_000);
    // An unmarked prompt into the running turn: a resend after an interrupt, or the relay's copy.
    hook('user_prompt_submit', { tool: 'claude', sessionId: 's' });
    expect(getWaitingEpisode(WT, 'claude')).toBeNull();

    // A wait under the re-opened turn N, then the marked copy restores R.
    const n = getAgentTurn(WT, 'claude', 'claude')!.turnId;
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt' });
    const opened = getWaitingEpisodeRecord(WT, 'claude')!;
    expect(opened.binding).toMatchObject({ kind: 'turn', turnId: n });
    expect(
      joinOpenTurnFromDuplicate(WT, 'claude', undefined, { event: 'user_prompt_submit', sessionId: 's', joinsOpenTurn: true })
    ).toBe(true);
    const r = getAgentTurn(WT, 'claude', 'claude')!.turnId;
    expect(r).not.toBe(n);
    expect(getWaitingEpisodeRecord(WT, 'claude')).toMatchObject({ episodeId: opened.episodeId, binding: { turnId: r } });
  });

  it('SessionStart after process-start keeps the screen wait and closes the others', () => {
    beginAgentEventGeneration(WT, TOOL, TOOL, Date.now());
    const generation = getAgentTurn(WT, TOOL, TOOL);
    expect(generation).toBeNull();
    openEpisode(
      { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL },
      {
        since: Date.now(),
        kind: 'menu',
        binding: { kind: 'screen', generation: { kind: 'opened', at: Date.now() }, originTurnId: null },
        openedBy: 'status-probe',
      },
      Date.now()
    );
    const screen = getWaitingEpisodeRecord(WT, TOOL)!;
    const edges: WaitingEpisodeTransition[] = [];
    onWaitingEpisodeTransition((t) => edges.push(t));

    vi.setSystemTime(Date.now() + 2_000);
    hook('session_start', { sessionId: CONVERSATION });
    expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(screen.episodeId);
    expect(edges).toEqual([]);

    // A non-screen wait is closed by the next session start.
    clearWaitingEpisodes();
    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
    vi.setSystemTime(Date.now() + 2_000);
    hook('session_start', { sessionId: 'another' });
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', closeReason: 'generation' });
  });
});

describe('[#3798] positive controls', () => {
  it('positive: UAT run 1 / runs 3,4,6,7 shapes', async () => {
    // Run 1: answered at +0.3 s, stop at +4 s.
    await previousTurn();
    const first = Date.now();
    expect(responseCheckerSeesPrompt()).toMatchObject({ since: first, suppress: true });
    await flush();
    await pollerAnswers();
    await agyHook('post_tool_use');
    await vi.advanceTimersByTimeAsync(3_720);
    await agyHook('stop');

    // Runs 3/4: two minutes later the next confirmation opens its own wait and is held.
    await vi.advanceTimersByTimeAsync(120_000);
    const secondAt = Date.now();
    expect(responseCheckerSeesPrompt(secondAt)).toMatchObject({
      since: secondAt,
      suppress: true,
      reason: 'auto-yes-answering',
    });
    await flush();
    await pollerAnswers(437);
    await agyHook('post_tool_use');
    await vi.advanceTimersByTimeAsync(3_000);
    await agyHook('stop');
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();

    expect(allowedLines()).toEqual([]);
    expect(promptPushes()).toEqual([]);
  });

  it('positive: a human-required screen is allowed about 9 s in', async () => {
    responseCheckerSeesPrompt();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1);
    await flush();
    expect(promptPushes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(allowedLines()).toEqual([expect.objectContaining({ reason: 'auto-yes-not-answered', waitingSince: T0 })]);
    expect(promptPushes()).toHaveLength(1);
  });

  it('negative: the closing edge itself notifies nothing', async () => {
    clearAllAutoYesStates();
    await agyHook('post_tool_use');
    responseCheckerSeesPrompt();
    await flush();
    expect(promptPushes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    await agyHook('stop');
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    expect(promptPushes()).toHaveLength(1);
  });
});
