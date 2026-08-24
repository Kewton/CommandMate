/**
 * Producer 1 of 2 (Issue #1999): the response poller's prompt branch.
 *
 * Driven through `checkForResponse` against a real pane and a real in-memory
 * database, so what is pinned is the poller's actual prompt path rather than a
 * re-statement of the gate (`tests/unit/push/prompt-push-gate-1999.test.ts`
 * covers the decision, and `tests/unit/push/auto-yes-waiting-push-1999.test.ts`
 * covers the other producer — a gate wired to only one of the two fails one of
 * these files).
 *
 * The half this file guards hardest is what must NOT change: Auto-Yes silences
 * the notification and nothing else. The prompt is still recorded, still
 * broadcast, and the waiting episode still opens — the last of those is what
 * keeps the WebSocket frame, the status API and the #1790 reminder seeing the
 * wait, and it is the thing a "just skip the whole block" fix would break.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), stopPolling: vi.fn() }));
// Partial, not whole-module: `response-checker` reads the capture-window width
// and the saturation predicate off this module on the path these tests drive,
// and a whole-module replacement makes those undefined — which `checkForResponse`
// then reports as an ordinary "no response found" (see #1547's suite).
vi.mock('@/lib/tmux/tmux-capture-cache', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>();
  return { ...actual, invalidateCache: vi.fn() };
});
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `claude-${id}`, name: 'Claude' }),
    }),
  },
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn(async () => true);
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...(a as [])),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const broadcastMessage = vi.fn();
/** Typed by the field the assertions read, so `mock.calls` is not a 0-tuple. */
type PushEvent = Record<string, unknown>;
const notifyPushSubscribers = vi.fn(async (_event: PushEvent) => {});
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));
// Only the barrel — `prompt-push-gate` is deliberately reached through its own
// module path by `response-checker`, so the real gate runs here.
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...(a as [PushEvent])),
}));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));

vi.mock('@/lib/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
    getSessionState: () => ({ lastCapturedLine: 0 }),
    updateSessionState: vi.fn(),
    getWorktreeById: () => ({ id: 'wt-1999i', name: 'auto-yes worktree' }),
    clearInProgressMessageId: vi.fn(),
    markPendingPromptsAsAnswered: vi.fn(() => 0),
  };
});

import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  clearPolicySuppressions,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling as resetResponsePollerCache } from '@/lib/polling/response-poller-core';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisode,
} from '@/lib/session/waiting-episode-state';
import { stopWaitingPushNotifier } from '@/lib/push/waiting-push-notifier';

const WORKTREE_ID = 'wt-1999i';
const T0 = 1_800_000_000_000;

/** A Claude pane sitting on a permission prompt, with scrollback above it. */
const PANE = [
  '❯ apply the refactor',
  '',
  '⏺ I need permission to edit the file.',
  '',
  'Do you want to make this edit to useVirtualKeyboard.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/** Every prompt notification the poller fanned out. */
function promptPushes(): PushEvent[] {
  return notifyPushSubscribers.mock.calls
    .map(([event]) => event)
    .filter(event => event.kind === 'prompt');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  resetResponsePollerCache(WORKTREE_ID, 'claude');
  vi.clearAllMocks();
  isSessionRunning.mockResolvedValue(true);
  captureSessionOutput.mockResolvedValue(PANE);

  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearWaitingEpisodes();
});

afterEach(() => {
  vi.useRealTimers();
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  db.close();
});

describe('Issue #1999: the poller does not push a prompt Auto-Yes will answer', () => {
  it('fans out no prompt notification while Auto-Yes is enabled', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true);

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(promptPushes()).toEqual([]);
  });

  it('records, broadcasts and opens the episode exactly as before', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true);

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);

    const promptMessages = createMessage.mock.calls
      .map(([, message]) => message)
      .filter(message => message.messageType === 'prompt');
    expect(promptMessages).toHaveLength(1);

    expect(broadcastMessage).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ worktreeId: WORKTREE_ID })
    );

    // The wait is still observable: suppressing the push must not blind the
    // WebSocket frame, the status API or the #1790 reminder.
    expect(getWaitingEpisode(WORKTREE_ID, 'claude')).toMatchObject({ kind: 'prompt' });
  });

  it('suppresses only the instance that has Auto-Yes on', async () => {
    setAutoYesEnabled(WORKTREE_ID, 'claude', true, undefined, undefined, 'claude-2');

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(promptPushes()).toHaveLength(1);
  });
});

describe('Issue #1999: Auto-Yes off leaves the poller untouched', () => {
  it('pushes the prompt with the same payload it always did', async () => {
    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);

    expect(promptPushes()).toHaveLength(1);
    expect(promptPushes()[0]).toMatchObject({
      worktreeId: WORKTREE_ID,
      kind: 'prompt',
      agentName: 'claude',
      instanceId: 'claude',
      waitingKind: 'prompt',
      excerpt: expect.stringContaining('useVirtualKeyboard.ts'),
    });
  });
});

describe('Issue #1999: a withheld answer still reaches a human', () => {
  it('pushes when the policy already suppressed an answer for this wait', async () => {
    // Pinned so the record and the episode share one clock reading: the
    // suppression has to land at or after the wait opened to count as this
    // wait's reason, and the episode's `since` is read from `Date.now()` inside
    // `checkForResponse`.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setAutoYesEnabled(WORKTREE_ID, 'claude', true);
    // The Auto-Yes poller re-records this on every poll while the prompt is on
    // screen, so by the time the response poller reports the wait it is current.
    recordPolicySuppression(
      WORKTREE_ID,
      'claude',
      undefined,
      { reason: 'deny-pattern', mode: 'safe', promptType: 'approval', pattern: 'force-push' },
      T0
    );

    expect(await checkForResponse(WORKTREE_ID, 'claude')).toBe(true);
    expect(promptPushes()).toHaveLength(1);
  });
});
