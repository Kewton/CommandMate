/**
 * Issue #3798 (PR 1b): the Auto-Yes poller as an observer of the waiting
 * episodes (`docs/design/issue-3798-waiting-episode.md` §2.4 tables O-1 / O-2,
 * §2.5 "Auto-Yes poller", R3-1, P3-1).
 *
 * A tick with nothing for Auto-Yes to answer reads the frame the way the status
 * probe does — without the agy receipt window (I9) — so a survey after an
 * answer becomes a person's `screen`, which the turn's stop does not end; the
 * poller ends it when the screen clears on a frame fetched after it became one.
 * A wait the poller did not answer is left to the stop and the status probe.
 *
 * Driven through the real poller with fake timers, over agy's live frames
 * (`tests/fixtures/antigravity-live-2364`), with the capture stood in for.
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

const capture = vi.hoisted(() => ({ frame: '', fetchStartedAt: null as number | null }));
vi.mock('@/lib/session/cli-session', () => ({
  // Issue #3798: and tells the observer where the frame came from, as cli-session does.
  captureSessionOutput: vi.fn(async () => {
    globalThis.__captureFrameMetaSink?.getStore()?.(
      capture.fetchStartedAt === null
        ? { fetchStartedAt: Date.now(), source: 'fetched' }
        : { fetchStartedAt: capture.fetchStartedAt, source: 'cache' },
    );
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

import {
  clearAllAutoYesStates,
  POLLING_INTERVAL_MS,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAllAutoYesPolling } from '@/lib/auto-yes-poller';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { startWaitingObservation } from '@/lib/session/waiting-episode-binding';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-ay';
const TOOL = 'antigravity' as const;
const PARTS = { worktreeId: WT, cliToolId: TOOL, instanceId: TOOL };
const T0 = 1_800_000_000_000;
const LIVE = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const fixture = (name: string): string => readFileSync(path.join(LIVE, `${name}.txt`), 'utf8');
const SURVEY = fixture('survey-after-deny.reconstructed');
const CONFIRMATION = fixture('dialog-bash-oneline');
const IDLE = fixture('idle-after-deny');

let edges: WaitingEpisodeTransition[] = [];

const record = () => getWaitingEpisodeRecord(WT, TOOL, TOOL);

function event(e: string, at: number = Date.now()): void {
  recordAgentEvent(WT, TOOL, TOOL, { event: e as never, at, detail: null, sessionId: 's-1' });
}

/** One poller tick over `frame`. */
async function pollerTick(frame: string): Promise<void> {
  capture.frame = frame;
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
}

/** One status probe over `frame` (the browser, or `commandmate ls`). */
async function statusProbe(frame: string): Promise<void> {
  capture.frame = frame;
  await detectWorktreeSessionStatus(
    WT,
    new Set([`cm-${WT}-antigravity`]),
    db as never,
    vi.fn(() => []),
    vi.fn(),
    vi.fn(() => []),
  );
}

function openWait(binding: Parameters<typeof openEpisode>[1]['binding'], at: number = Date.now()) {
  return openEpisode(PARTS, { since: at, kind: 'prompt', binding, openedBy: 'status-probe' }, at);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  capture.frame = IDLE;
  capture.fetchStartedAt = null;
  resetAntigravityPermissionReceiptsForTests();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  edges = [];
  onWaitingEpisodeTransition((t) => {
    if (t.cliToolId === TOOL) edges.push(t);
  });
  event('session_start', T0 - 10_000);
  setAutoYesEnabled(WT, TOOL, true);
  expect(startAutoYesPolling(WT, TOOL).started).toBe(true);
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  resetAntigravityPermissionReceiptsForTests();
  db.close();
  vi.useRealTimers();
});

describe('[#3798] the poller and a person\'s screen', () => {
  it('answer → survey: poller opens/rebinds screen; stop leaves it; human answers; poller not-waiting closes it', async () => {
    // The confirmation's wait, read before its turn; the answer's post_tool_use binds it.
    const opened = openWait({ kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null });
    event('post_tool_use');
    expect(record()?.binding.kind).toBe('turn');

    await pollerTick(SURVEY);
    expect(record()).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'screen' } });

    event('stop');
    expect(record()?.episodeId).toBe(opened.episodeId);
    await pollerTick(SURVEY);
    expect(record()?.episodeId).toBe(opened.episodeId);

    // The person answers the survey in tmux.
    await pollerTick(IDLE);
    expect(record()).toBeNull();
    expect(edges.map((e) => [e.cause, e.closeReason])).toEqual([
      ['opened', null],
      ['closed', 'screen-cleared'],
    ]);
  });

  it('opens the screen itself when no wait is open', async () => {
    await pollerTick(SURVEY);
    expect(record()).toMatchObject({ binding: { kind: 'screen' }, openedBy: 'auto-yes-poller' });
  });

  it('a not-waiting frame fetched before the screen opened does not close it', async () => {
    const opened = openWait({ kind: 'screen', generation: startWaitingObservation(WT, TOOL, TOOL).generation, originTurnId: null });
    capture.fetchStartedAt = opened.openedAt - 1_000;
    await pollerTick(IDLE);
    expect(record()?.episodeId).toBe(opened.episodeId);

    // Control: a frame fetched after it closes it.
    capture.fetchStartedAt = null;
    await pollerTick(IDLE);
    expect(record()).toBeNull();
  });

  it('does not close a wait that is not a screen (not its answer: PR 3)', async () => {
    const opened = openWait({ kind: 'unattributed', generation: startWaitingObservation(WT, TOOL, TOOL).generation, lastClosedTurnId: null });
    await pollerTick(IDLE);
    expect(record()?.episodeId).toBe(opened.episodeId);
  });
});

describe('[#3798] the receipt window does not decide the reading (I9)', () => {
  it('a receipt-window-outside agy confirmation is not screen; stop closes the wait', async () => {
    // No permission receipt: Auto-Yes leaves the confirmation alone (no_prompt).
    await pollerTick(CONFIRMATION);
    const opened = record();
    expect(opened).not.toBeNull();
    expect(opened!.binding.kind).not.toBe('screen');

    // The person approves it; the agent's turn ends.
    event('stop');
    expect(record()).toBeNull();
  });
});

describe('[#3798] two observers, one wait', () => {
  it.each([
    ['a survey', SURVEY, 'screen'],
    ['a confirmation outside the receipt window', CONFIRMATION, 'unattributed'],
  ] as const)('status-helper and poller alternating six times on %s: one opening edge, same id', async (_label, frame, kind) => {
    await statusProbe(frame);
    const opened = record()!;
    expect(opened.binding.kind).toBe(kind);
    for (let i = 0; i < 3; i++) {
      await pollerTick(frame);
      await statusProbe(frame);
    }
    expect(record()).toMatchObject({ episodeId: opened.episodeId, since: opened.since });
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});
