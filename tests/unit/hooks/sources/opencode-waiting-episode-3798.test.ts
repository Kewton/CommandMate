/**
 * Issue #3798 on the two opencode ingests: a stop closes the wait of the turn
 * it ended, when the stop is recorded — not when the ingest gets back from the
 * await that follows (`applyStop`'s dynamic imports, V2's `stopEffect`).
 *
 * The opencode ingests record a `stop` into the turn model and then await
 * before `applyAgentStopEvent`; the stream does not wait for an ingest to
 * finish. A turn that begins in that gap, and the wait it opens, are the next
 * turn's. Each await case starts the ingest without awaiting it, checks the
 * stop is already recorded (the ingest is parked), lets turn B begin, and only
 * then lets the ingest finish. Design: `docs/design/issue-3798-waiting-episode.md`
 * §2.5, §3.
 *
 * Scaffold as in `tests/unit/api/hooks-agent-event-waiting-episode-3798.test.ts`:
 * real database, only `web-push` stubbed, plus the transcript reader the stop
 * path asks.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
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

vi.mock('@/lib/hooks/stop-history-capture', () => ({
  resolveStopTranscriptCapture: vi.fn(async () => ({ status: 'unavailable', settled: Promise.resolve(false) })),
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
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getLastAgentEvent,
  recordAgentEvent,
  reportQuestionPending,
} from '@/lib/session/agent-event-state';
import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { ingestOpencodeV2Event } from '@/lib/hooks/sources/opencode-v2/ingest';
import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import { deliverOpencodeV2Frame } from '@/lib/hooks/sources/opencode-v2/subscription';
import { resetPendingDecisions, type NormalizedAgentEvent } from '@/lib/hooks/sources';
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
} from '@/lib/session/waiting-episode-state';

const T0 = 1_792_315_694_804;
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

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

/** One opencode flavour: how its `stop` reaches the ingest, and its session. */
interface Source {
  name: string;
  worktreeId: string;
  tool: CLIToolType;
  sessionId: string;
  /** Start the ingest of one completed turn; resolves when the ingest returns. */
  ingestStop(): Promise<void>;
}

const opencode: Source = {
  name: 'OpenCode',
  worktreeId: 'wt-3798-oc',
  tool: 'opencode',
  sessionId: 'ses_0000000000000000000000000',
  ingestStop() {
    const payload = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/fixtures/hooks/opencode/session-idle.json'), 'utf8'),
    ) as Record<string, unknown>;
    const event = opencodeAgentEventSource.normalizeEvent({ payload, receivedAt: Date.now() });
    if (!event) throw new Error('session-idle did not normalise');
    return ingestOpencodeEvent({ worktreeId: this.worktreeId, cliToolId: 'opencode', instanceId: 'opencode' }, event);
  },
};

const opencodeV2: Source = {
  name: 'OpenCode V2',
  worktreeId: 'wt-3798-oc2',
  tool: 'opencode-v2',
  sessionId: 'ses_f194e1bf3ffeD8Ak2TrW5f3pwe',
  ingestStop() {
    const frames = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/fixtures/opencode-v2-live-2934/sse-measured-turn.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    const frame = frames.find((f) => f.type === 'session.execution.succeeded');
    const events: NormalizedAgentEvent[] = [];
    deliverOpencodeV2Frame(frame!, (raw) => opencodeV2AgentEventSource.normalizeEvent(raw), (e) => events.push(e), Date.now());
    if (events.length !== 1) throw new Error('succeeded frame did not normalise to one event');
    return ingestOpencodeV2Event({ worktreeId: this.worktreeId, cliToolId: 'opencode-v2', instanceId: 'opencode-v2' }, events[0]);
  },
};

for (const source of [opencode, opencodeV2]) {
  const { worktreeId: WT, tool: TOOL } = source;

  /** A turn start, as the ingest records it. */
  function turnStarts(sessionId = source.sessionId): void {
    recordAgentEvent(WT, TOOL, TOOL, { event: 'user_prompt_submit', at: Date.now(), detail: null, sessionId });
  }

  /** A tool call that continues (or, with no turn, opens) a turn. */
  function toolRan(sessionId = source.sessionId): void {
    recordAgentEvent(WT, TOOL, TOOL, { event: 'post_tool_use', at: Date.now(), detail: null, sessionId });
  }

  /** The response poller's prompt branch, in its order: gate, then edge. */
  function responseCheckerSeesPrompt(): number {
    const now = Date.now();
    const since = getWaitingEpisode(WT, TOOL)?.since ?? now;
    decideAndLogPromptPush({ worktreeId: WT, cliToolId: TOOL, waitingSince: since, now });
    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt', now });
    return since;
  }

  function pollerAnsweredAt(at: number | null): void {
    const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
    const key = buildCompositeKey(WT, TOOL);
    if (at === null) states.delete(key);
    else states.set(key, { lastServerResponseTimestamp: at } as AutoYesPollerState);
  }

  /** Start the stop's ingest and return it parked on its await, the stop recorded. */
  function stopParkedOnItsAwait(): Promise<void> {
    const recordedBefore = getLastAgentEvent(WT, TOOL, TOOL);
    const pending = source.ingestStop();
    const recorded = getLastAgentEvent(WT, TOOL, TOOL);
    expect(recorded).not.toBe(recordedBefore);
    expect(recorded?.event).toBe('stop');
    return pending;
  }

  describe(`[#3798] ${source.name}: a stop closes its own turn's wait when it is recorded`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      vi.setSystemTime(T0);
      db = new Database(':memory:');
      runMigrations(db);
      db.prepare(
        `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(WT, 'uat-opencode', path.join('/nonexistent', WT), '/nonexistent/repo', 'repo', T0);
      upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

      savedEnv = {};
      for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
      process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

      sendNotification.mockReset();
      sendNotification.mockResolvedValue({ statusCode: 201 });
      infoLines.length = 0;

      clearWaitingEpisodes();
      clearWaitingTransitionListeners();
      stopWaitingPushNotifier();
      resetNotificationDedup();
      resetWaitingPushDedup();
      clearAllAutoYesStates();
      clearPolicySuppressions();
      clearAutoYesHolds();
      resetPendingDecisions();
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
      vi.useRealTimers();
      db.close();
      for (const key of VAPID_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it('positive: nothing happens during the await — the stop closes the answered wait, hold and reminder with it', async () => {
      turnStarts();
      responseCheckerSeesPrompt();
      expect(pendingEscalationCount()).toBe(1);
      await flush();
      await vi.advanceTimersByTimeAsync(315);
      pollerAnsweredAt(Date.now());
      await vi.advanceTimersByTimeAsync(3_720);

      const pending = stopParkedOnItsAwait();
      // Closed when recorded, before the ingest returns.
      expect(getWaitingEpisode(WT, TOOL)).toBeNull();
      await pending;
      expect(pendingEscalationCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
      await flush();
      expect(allowedLines()).toEqual([]);
      expect(promptPushes()).toEqual([]);
    });

    it('#3: turn B begins and waits during the await — B\'s wait stays (since, hold and reminder)', async () => {
      turnStarts();
      await vi.advanceTimersByTimeAsync(1_000);
      const pending = stopParkedOnItsAwait();

      vi.setSystemTime(Date.now() + 5);
      turnStarts();
      const sinceB = responseCheckerSeesPrompt();
      const b = getWaitingEpisodeRecord(WT, TOOL)!;

      await pending;
      expect(getWaitingEpisodeRecord(WT, TOOL)).toMatchObject({ episodeId: b.episodeId, since: sinceB });
      expect(pendingEscalationCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS);
      await flush();
      expect(allowedLines()).toEqual([expect.objectContaining({ reason: 'auto-yes-not-answered', waitingSince: sinceB })]);
      expect(promptPushes()).toHaveLength(1);
    });

    it('#4: A\'s wait open when A stops — B\'s prompt during the await gets its own id, since, hold and push', async () => {
      clearAllAutoYesStates();
      turnStarts();
      const sinceA = responseCheckerSeesPrompt();
      const a = getWaitingEpisodeRecord(WT, TOOL)!;
      await flush();
      expect(promptPushes()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const pending = stopParkedOnItsAwait();
      expect(getWaitingEpisode(WT, TOOL)).toBeNull();

      vi.setSystemTime(Date.now() + 5);
      turnStarts();
      const sinceB = responseCheckerSeesPrompt();
      await pending;
      await flush();

      const b = getWaitingEpisodeRecord(WT, TOOL)!;
      expect(b.episodeId).not.toBe(a.episodeId);
      expect(b.since).toBe(sinceB);
      expect(sinceB).toBeGreaterThan(sinceA);
      expect(promptPushes()).toHaveLength(2);
    });

    it('#6: a wait seen before its turn opens is the same wait once the turn opens (no reopen on refetch)', async () => {
      // A previous turn P, closed by its stop.
      turnStarts();
      await vi.advanceTimersByTimeAsync(1_000);
      await source.ingestStop();
      await vi.advanceTimersByTimeAsync(10_000);

      const edges: boolean[] = [];
      const { onWaitingTransition } = await import('@/lib/session/waiting-episode-state');
      onWaitingTransition((t) => edges.push(t.waiting));
      responseCheckerSeesPrompt();
      const opened = getWaitingEpisodeRecord(WT, TOOL)!;
      expect(opened.binding.kind).toBe('unattributed');

      vi.setSystemTime(Date.now() + 500);
      toolRan(); // the late start hook
      for (let i = 0; i < 3; i++) {
        vi.setSystemTime(Date.now() + 2_000);
        responseCheckerSeesPrompt();
      }
      expect(getWaitingEpisodeRecord(WT, TOOL)).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'turn' } });
      expect(edges).toEqual([true]);
    });

    it('#7: a stop parked, a new generation, B waiting before its first hook — B survives the late return', async () => {
      turnStarts();
      await vi.advanceTimersByTimeAsync(1_000);
      const pending = stopParkedOnItsAwait();
      beginAgentEventGeneration(WT, TOOL, TOOL, Date.now() + 1);
      vi.setSystemTime(Date.now() + 5);
      responseCheckerSeesPrompt();
      const b = getWaitingEpisodeRecord(WT, TOOL)!;
      await pending;
      expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b.episodeId);
    });

    it('#1: another session\'s idle while session B waits leaves B', () => {
      turnStarts('ses_B');
      responseCheckerSeesPrompt();
      const b = getWaitingEpisodeRecord(WT, TOOL)!;
      vi.setSystemTime(Date.now() + 4_000);
      recordAgentEvent(WT, TOOL, TOOL, { event: 'stop', at: Date.now(), detail: null, sessionId: 'ses_other' });
      expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b.episodeId);
    });

    it('a dialog-only wait is not closed by another session\'s idle, and is by its own', () => {
      recordAgentEvent(WT, TOOL, TOOL, {
        event: 'notification',
        at: Date.now(),
        detail: 'permission_prompt',
        sessionId: 'ses_B',
        decisionId: 'per_1',
      });
      observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
      const opened = getWaitingEpisodeRecord(WT, TOOL)!;
      expect(opened.binding).toMatchObject({ kind: 'dialog-only', sessionId: 'ses_B' });

      vi.setSystemTime(Date.now() + 1_000);
      recordAgentEvent(WT, TOOL, TOOL, { event: 'stop', at: Date.now(), detail: null, sessionId: 'ses_other' });
      expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(opened.episodeId);

      vi.setSystemTime(Date.now() + 1_000);
      recordAgentEvent(WT, TOOL, TOOL, { event: 'stop', at: Date.now(), detail: null, sessionId: 'ses_B' });
      expect(getWaitingEpisode(WT, TOOL)).toBeNull();
    });

    it('a permission answered by the API (decision-answered) closes the wait; the next prompt is a new wait', () => {
      turnStarts();
      recordAgentEvent(WT, TOOL, TOOL, {
        event: 'notification',
        at: Date.now(),
        detail: 'permission_prompt',
        sessionId: source.sessionId,
        decisionId: 'per_1',
      });
      responseCheckerSeesPrompt();
      const first = getWaitingEpisodeRecord(WT, TOOL)!;
      vi.setSystemTime(Date.now() + 1_000);
      // The record `adjudicatePermission` leaves once its await returns: settled.
      recordAgentEvent(WT, TOOL, TOOL, {
        event: 'notification',
        at: Date.now() - 900,
        detail: 'permission_replied',
        sessionId: source.sessionId,
        decisionId: 'per_1',
        promptSettled: true,
      });
      expect(getWaitingEpisode(WT, TOOL)).toBeNull();

      vi.setSystemTime(Date.now() + 5_000);
      responseCheckerSeesPrompt();
      expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).not.toBe(first.episodeId);
    });

    it('a question reported outside recordAgentEvent rebinds the wait the screen showed first', () => {
      responseCheckerSeesPrompt();
      expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('unattributed');
      reportQuestionPending(WT, TOOL, TOOL, { toolName: 'question', decisionId: 'que_1', detail: 'question' });
      expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('dialog-only');
    });
  });
}
