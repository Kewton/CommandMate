/**
 * Issue #3798 (PR 1b, review P2): the Auto-Yes poller reads an approval the
 * app answers over the agent's API (Issue #3184, `apiAnswerable`) as a
 * `prompt`, the way the status probe does — so the two observers reading the
 * same OpenCode V2 approval strip in turn do not flip the episode's kind
 * between `prompt` and `menu`, and the push body stays the one for a `prompt`.
 *
 * Driven through the real poller with fake timers and the real status probe,
 * over the live V2 approval frame (`tests/fixtures/opencode-v2-live-2945`),
 * with the capture stood in for.
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
  // Issue #3798: each capture is the observer's own fetch, reported as cli-session reports it.
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
      getTool: (id: string) => ({ getSessionName: (wt: string) => `cm-${wt}-${id}`, name: 'OpenCode' }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

import { clearAllAutoYesStates, POLLING_INTERVAL_MS, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearAllPollerStates, startAutoYesPolling, stopAllAutoYesPolling } from '@/lib/auto-yes-poller';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { buildPushPayload } from '@/lib/push/push-sender';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-api-kind';
const TOOL = 'opencode-v2' as const;
const T0 = 1_800_000_000_000;
// The #3184 permission id (tests/unit/lib/session/waiting-kind-api-answerable-3184.test.ts).
const PERMISSION_ID = 'per_3184kindPermission0000000';
const APPROVAL = readFileSync(
  path.resolve(__dirname, '../../fixtures/opencode-v2-live-2945/permission-required.txt'),
  'utf8',
);

let edges: WaitingEpisodeTransition[] = [];
const kinds: Array<string | null | undefined> = [];

const record = () => getWaitingEpisodeRecord(WT, TOOL, TOOL);

async function pollerTick(): Promise<void> {
  capture.frame = APPROVAL;
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
}

async function statusProbe(): Promise<void> {
  capture.frame = APPROVAL;
  await detectWorktreeSessionStatus(
    WT,
    new Set([`cm-${WT}-${TOOL}`]),
    db as never,
    vi.fn(() => []),
    vi.fn(),
    vi.fn(() => []),
  );
}

/** The agent reported the approval with its permission id. */
function approvalNotified(decisionId: string | null): void {
  recordAgentEvent(WT, TOOL, TOOL, {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'ses-3798',
    message: 'edit notes.txt',
    decisionId,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  db = new Database(':memory:');
  runMigrations(db);
  capture.frame = APPROVAL;
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  edges = [];
  kinds.length = 0;
  onWaitingEpisodeTransition((t) => {
    if (t.cliToolId === TOOL) edges.push(t);
  });
  recordAgentEvent(WT, TOOL, TOOL, { event: 'session_start', at: T0 - 10_000, detail: null, sessionId: 'ses-3798' });
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllPollerStates();
  clearAllAutoYesStates();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  db.close();
  vi.useRealTimers();
});

/** Status probe, then poller and probe in turn three times; the kind after each. */
async function alternate(): Promise<void> {
  setAutoYesEnabled(WT, TOOL, true);
  expect(startAutoYesPolling(WT, TOOL).started).toBe(true);
  await statusProbe();
  kinds.push(record()?.kind);
  for (let i = 0; i < 3; i++) {
    await pollerTick();
    kinds.push(record()?.kind);
    await statusProbe();
    kinds.push(record()?.kind);
  }
}

describe('[#3798] the API-answerable approval stays a prompt across observers (#3184)', () => {
  it('the source names decisions by permission id (the #3184 precondition)', () => {
    expect(getAgentEventSource(TOOL).capabilities.eventIdentity).toBe('permission-id');
  });

  it('status-helper and poller alternating: kind stays prompt, one episode, prompt push body', async () => {
    approvalNotified(PERMISSION_ID);
    await alternate();
    const opened = record()!;
    expect(kinds).toEqual(Array(7).fill('prompt'));
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
    expect(opened.episodeId).toBe(edges[0]!.episodeId);

    const base = { worktreeId: WT, worktreeName: 'wt', kind: 'prompt' as const, excerpt: 'edit notes.txt' };
    const body = buildPushPayload({ ...base, waitingKind: opened.kind }, 'en').body;
    expect(body).toBe(buildPushPayload({ ...base, waitingKind: 'prompt' }, 'en').body);
    expect(body.toLowerCase()).not.toContain('terminal');
  });

  it('control: without an addressable permission id both observers read the strip as a menu', async () => {
    approvalNotified(null);
    await alternate();
    expect(kinds).toEqual(Array(7).fill('menu'));
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});
