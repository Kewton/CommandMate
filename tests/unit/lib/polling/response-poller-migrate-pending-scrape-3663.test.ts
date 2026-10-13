/**
 * Issue #3663: a worktree-ID batch rename carries the held scrape (#2436).
 *
 * `migrateResponsePollerWorktreeIds` moved the poller and its dedup state to the
 * new ID but left `__pendingScrapedResponses` under the old poller key. The
 * restarted poller then never found the hold: its expiry check runs under the
 * new key, and the old key's hold was written by nothing (or, if the old key
 * was ever stopped, written against the worktree ID the rename had retired).
 *
 * The poller loop itself is stubbed (`checkForResponse`), but the held-scrape
 * module is the real one — `flushPendingScrapedResponse` in the stub is the
 * real function — so the hold is taken out the way a stop or an expiry takes
 * it out, and the row it writes is read off the mocked `createMessage`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'row', ...m }));
const captureStructuredHistoryTurn = vi.fn(async () => false);

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/db', () => ({
  createMessage: (db: unknown, m: Record<string, unknown>) => createMessage(db, m),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: () => false,
  captureStructuredHistoryTurn: () => captureStructuredHistoryTurn(),
}));
vi.mock('@/lib/polling/response-checker', async () => {
  const pending = await import('@/lib/polling/pending-scraped-response');
  return {
    checkForResponse: vi.fn(async () => false),
    flushPendingScrapedResponse: pending.flushPendingScrapedResponse,
  };
});
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import {
  startPolling,
  stopAllPolling,
  migrateResponsePollerWorktreeIds,
} from '@/lib/polling/response-poller-core';
import {
  PENDING_SCRAPE_HOLD_MS,
  holdScrapedResponse,
  hasPendingScrapedResponse,
  flushPendingScrapedResponse,
  resetPendingScrapedResponses,
  settleExpiredPendingScrapedResponse,
} from '@/lib/polling/pending-scraped-response';
import { renameResponseHashCacheKey } from '@/lib/polling/response-dedup';

type Globals = {
  __pendingScrapedResponses?: Map<string, { worktreeId: string; content: string; expiresAt: number }>;
};
const g = globalThis as Globals;

const TOOL: CLIToolType = 'claude';
const WT = { a: 'wt-3663-a', b: 'wt-3663-b', c: 'wt-3663-c', x: 'wt-3663-x' };
const key = (wt: string): string => `${wt}:${TOOL}`;
const NOW = new Date('2026-10-13T09:00:00.000Z').getTime();

/** Park a held reply under `wt`'s poller key, as `checkForResponse` would. */
function hold(wt: string, content: string, expiresAt = NOW + PENDING_SCRAPE_HOLD_MS): void {
  holdScrapedResponse(key(wt), {
    worktreeId: wt,
    cliToolId: TOOL,
    instanceId: TOOL,
    content,
    timestamp: new Date(NOW),
    worktreePath: '/repo/worktree',
    transcriptPathHint: null,
    expiresAt,
  });
}

function heldAt(wt: string) {
  const p = g.__pendingScrapedResponses?.get(key(wt));
  return p ? { worktreeId: p.worktreeId, content: p.content, expiresAt: p.expiresAt } : undefined;
}

function writtenRows(): Array<{ worktreeId: unknown; content: unknown }> {
  return createMessage.mock.calls.map(([, m]) => ({ worktreeId: m.worktreeId, content: m.content }));
}

const resolveTool = (): CLIToolType => TOOL;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  stopAllPolling();
  resetPendingScrapedResponses();
  createMessage.mockClear();
  captureStructuredHistoryTurn.mockClear();
});

afterEach(() => {
  resetPendingScrapedResponses();
  stopAllPolling();
  vi.useRealTimers();
});

describe('Issue #3663: migrate moves the held scrape with the poller', () => {
  it('a hold under the old ID is taken out under the new ID, and written there', () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    // Before: the hold is at the old key.
    expect(hasPendingScrapedResponse(key(WT.a))).toBe(true);
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toEqual({
      worktreeId: WT.b,
      content: 'reply A',
      expiresAt: NOW + PENDING_SCRAPE_HOLD_MS,
    });
    // The migrate itself writes nothing: the hold is moved, not flushed.
    expect(createMessage).not.toHaveBeenCalled();

    expect(flushPendingScrapedResponse(key(WT.a), 'test')).toBe(false);
    expect(flushPendingScrapedResponse(key(WT.b), 'test')).toBe(true);
    expect(writtenRows()).toEqual([{ worktreeId: WT.b, content: 'reply A' }]);
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });

  it('the moved hold keeps its deadline: not settled early, settled once it expires', async () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    vi.setSystemTime(NOW + 1_000);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    await settleExpiredPendingScrapedResponse(key(WT.b));
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(true);
    expect(createMessage).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + PENDING_SCRAPE_HOLD_MS);
    await settleExpiredPendingScrapedResponse(key(WT.b));
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
    expect(writtenRows()).toEqual([{ worktreeId: WT.b, content: 'reply A' }]);
  });

  it('A↔B swap keeps each hold on its own poller, under the new IDs', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.a, 'reply A');
    hold(WT.b, 'reply B');

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply B' });
  });

  it('A→B→C chain moves every hold one step, none lost or mixed', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);
    hold(WT.a, 'reply A');
    hold(WT.b, 'reply B');

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.c },
      ],
      resolveTool
    );

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(heldAt(WT.c)).toMatchObject({ worktreeId: WT.c, content: 'reply B' });
  });

  it('a chain paused on a prompt carries its hold too', () => {
    hold(WT.a, 'reply A');
    const coordinator = (globalThis as { __responsePollerCoordinator?: { pausedOnPrompt: Set<string> } })
      .__responsePollerCoordinator;
    coordinator?.pausedOnPrompt.add(key(WT.a));

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    coordinator?.pausedOnPrompt.delete(key(WT.b));
  });

  it('a hold already at a destination that is not moving is replaced by the moved one', () => {
    startPolling(WT.a, TOOL);
    hold(WT.a, 'reply A');
    // A stale hold at B whose poller is not part of this batch.
    hold(WT.b, 'stale B');

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(heldAt(WT.b)).toMatchObject({ worktreeId: WT.b, content: 'reply A' });
    expect(hasPendingScrapedResponse(key(WT.a))).toBe(false);
  });

  it('negative: with no holds, migrate leaves the held-scrape map empty and writes nothing', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.b, TOOL);

    migrateResponsePollerWorktreeIds(
      [
        { oldId: WT.a, newId: WT.b },
        { oldId: WT.b, newId: WT.a },
      ],
      resolveTool
    );

    expect(g.__pendingScrapedResponses?.size ?? 0).toBe(0);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('negative: a hold of a worktree outside the batch is left exactly as it was', () => {
    startPolling(WT.a, TOOL);
    startPolling(WT.x, TOOL);
    hold(WT.x, 'reply X');
    const before = heldAt(WT.x);

    migrateResponsePollerWorktreeIds([{ oldId: WT.a, newId: WT.b }], resolveTool);

    expect(heldAt(WT.x)).toEqual(before);
    expect(heldAt(WT.x)).toMatchObject({ worktreeId: WT.x, content: 'reply X' });
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });

  it('the single dedup rename does not touch held scrapes', () => {
    hold(WT.a, 'reply A');
    renameResponseHashCacheKey(key(WT.a), key(WT.b));
    expect(heldAt(WT.a)).toMatchObject({ worktreeId: WT.a, content: 'reply A' });
    expect(hasPendingScrapedResponse(key(WT.b))).toBe(false);
  });
});
