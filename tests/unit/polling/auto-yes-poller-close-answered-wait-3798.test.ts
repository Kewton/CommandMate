/**
 * Issue #3798 (PR 3): which waits the Auto-Yes poller's answer lets it close,
 * over agy's live frames (`tests/fixtures/antigravity-live-2364`).
 *
 * The cases of the held branch's `auto-yes-poller-close-answered-wait-3798`
 * (`07610c745`) — a survey or a picker after the answer, the trust screen, a
 * dialog withheld for want of a hook receipt — rewritten on
 * `lastAnswer.episodeId` (design §7): an answer counts for the episode it was
 * recorded for, never by comparing its time with the episode's `since`
 * (design 規則 1). The answer itself is driven in
 * `auto-yes-poller-answered-episode-3798.test.ts`; here the poller state
 * carries it, as the answering tick leaves it.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const capture = vi.hoisted(() => ({ frame: '' }));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => {
    globalThis.__captureFrameMetaSink?.getStore()?.({ fetchStartedAt: Date.now(), source: 'fetched' });
    return capture.frame;
  }),
  captureSessionOutputFresh: vi.fn(async () => capture.frame),
  getSessionPresence: vi.fn(async () => 'present'),
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/prompt-answer-sender', () => ({ sendPromptAnswer: vi.fn(async () => {}) }));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { buildCompositeKey, clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAllAutoYesPolling } from '@/lib/auto-yes-poller';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import { clearStartupTrust } from '@/lib/cli-tools/antigravity-startup-trust';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { startWaitingObservation } from '@/lib/session/waiting-episode-binding';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-close-answered';
const TOOL = 'antigravity' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const T0 = 1_800_000_000_000;
const LIVE = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const fixture = (name: string): string => readFileSync(path.join(LIVE, `${name}.txt`), 'utf8');
const IDLE = fixture('idle-after-deny');

let edges: WaitingEpisodeTransition[] = [];

const record = () => getWaitingEpisodeRecord(WT, TOOL, TOOL);

async function pollerTick(frame: string): Promise<void> {
  capture.frame = frame;
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
}

/** The confirmation's wait, as another observer opened it. */
function openWait() {
  return openEpisode(
    PARTS,
    {
      since: Date.now(),
      kind: 'prompt',
      binding: { kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null },
      openedBy: 'response-checker',
    },
    Date.now(),
  );
}

/** What the answering tick leaves on the poller state. */
function answered(episodeId: string): void {
  const state = globalThis.__autoYesPollerStates?.get(buildCompositeKey(WT, TOOL, TOOL));
  expect(state).toBeDefined();
  state!.lastAnswer = { episodeId, screenKey: 'the answered confirmation', at: Date.now() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  capture.frame = IDLE;
  resetAntigravityPermissionReceiptsForTests();
  clearStartupTrust();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  edges = [];
  onWaitingEpisodeTransition((t) => {
    if (t.worktreeId === WT) edges.push(t);
  });
  recordAgentEvent(WT, TOOL, TOOL, { event: 'session_start' as never, at: T0 - 10_000, detail: null, sessionId: 's-1' });
  setAutoYesEnabled(WT, TOOL, true);
  expect(startAutoYesPolling(WT, TOOL).started).toBe(true);
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearAgentStopEvents();
  clearStartupTrust();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  resetAntigravityPermissionReceiptsForTests();
  db.close();
  vi.useRealTimers();
});

describe('[#3798] the poller closes the wait it answered once the prompt is gone', () => {
  it('positive: answered this episode, then an idle pane — the episode closes (one closing edge)', async () => {
    const opened = openWait();
    answered(opened.episodeId);
    await pollerTick(IDLE);
    expect(record()).toBeNull();
    expect(edges.map((e) => [e.cause, e.closeReason])).toEqual([
      ['opened', null],
      ['closed', 'poller-answered'],
    ]);
  });

  it('negative: an answer recorded for an earlier episode does not close this one', async () => {
    const opened = openWait();
    answered('wep-earlier-episode');
    await pollerTick(IDLE);
    expect(record()?.episodeId).toBe(opened.episodeId);
  });

  it('negative: a poller that never answered does not close it', async () => {
    const opened = openWait();
    await pollerTick(IDLE);
    expect(record()?.episodeId).toBe(opened.episodeId);
  });

  it('negative: the trust screen (nobody here answers it) stays open even after an answer', async () => {
    const opened = openWait();
    answered(opened.episodeId);
    await pollerTick(fixture('trust-dialog'));
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });

  it('negative: a dialog withheld for want of a hook receipt is still on screen — stays open', async () => {
    const raw = fixture('dialog-bash-oneline');
    const clean = stripBoxDrawing(stripAnsi(raw));
    // Precondition: gated (no receipt) it reads as no prompt; ungated it is one.
    expect(
      detectPromptOnCleanFrame(clean, TOOL, clean.split('\n'), raw, { worktreeId: WT, instanceId: TOOL }).isPrompt,
    ).toBe(false);
    expect(detectPromptOnCleanFrame(clean, TOOL, clean.split('\n'), raw).isPrompt).toBe(true);

    const opened = openWait();
    answered(opened.episodeId);
    await pollerTick(raw);
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});

describe('[#3798] an answered prompt followed by a screen only a person can drive keeps the wait', () => {
  for (const name of ['survey-after-deny.reconstructed', 'picker-switch-model']) {
    it(`negative: ${name} after the answer — the same episode stays, as a person's screen`, async () => {
      const opened = openWait();
      answered(opened.episodeId);
      await pollerTick(fixture(name));
      expect(record()).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'screen' } });
      expect(edges.map((e) => e.cause)).toEqual(['opened']);
    });
  }

  it('positive: the same answered wait, then an idle pane — closed once the screen clears', async () => {
    const opened = openWait();
    answered(opened.episodeId);
    await pollerTick(fixture('survey-after-deny.reconstructed'));
    expect(record()?.episodeId).toBe(opened.episodeId);

    await pollerTick(IDLE);
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', previousEpisodeId: opened.episodeId });
  });
});
