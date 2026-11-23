/**
 * Issue #4534 PR-B s2 r2: the two entry branches the route tables cannot reach
 * because the send service keeps them consistent — pinned here with the send
 * service as a caller's stub (the shape #4064 already reads: a result with no
 * reported attempt), so each branch is the only thing that decides.
 *
 * - b P3-4 (`relay-delivery.ts` `isNotSent`): a result that carries the fence's
 *   outcome but reports no attempt is settled by the fence's state —
 *   `indeterminate` held, `not-sent` queued again. Without the fence's clause
 *   the missing attempt reads as not sent and an `indeterminate` one is retyped.
 * - b P3-3 (`timer-manager.ts`, the catch): a send that THROWS this request's
 *   own refusal keeps `[target_changed]` at the head of the timer's reason.
 *
 * Fake: the process boundary (`./send-fence-process`), the send service, the
 * relay readiness probe. The DB is an in-memory one with every migration.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('child_process', async () => (await import('./send-fence-process')).fakeChildProcess());
let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
const sendUserMessage = vi.fn();
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({ findRelayHoldReason: vi.fn(async () => null) }));

import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import { createTimer, getTimerById } from '@/lib/db/timer-db';
import { pumpRelayDeliveries, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { getActiveTimerCount, scheduleTimer, stopAllTimers } from '@/lib/timer-manager';
import { currentSendRequestId, resetFenceForTests, SendTargetChangedError } from '@/lib/session/terminal-fence';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { addPane, resetWorld } from './send-fence-process';

const NOW = Date.now();
const WT_A = 'wt-outcome-a';
const WT_B = 'wt-outcome-b';

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

beforeEach(() => {
  resetWorld();
  resetFenceForTests();
  resetRelayDeliveryState();
  db = new Database(':memory:');
  runMigrations(db);
  insertWorktree(WT_A, 'claude');
  insertWorktree(WT_B, 'codex');
  sendUserMessage.mockReset();
});
afterEach(() => {
  stopAllTimers();
  resetRelayDeliveryState();
  db.close();
});

/** The fence's outcome as the send service puts it on a failed result. */
const fenceOutcome = (state: 'not-sent' | 'indeterminate') => ({
  kind: 'target-changed' as const,
  state,
  order: 1 as const,
  refusal: new SendTargetChangedError('tool-changed', 'send-1-1'),
});

describe('b P3-4: the relay settles a fenced result by the fence’s state (no attempt reported)', () => {
  function relayWithReply(): string {
    const relay = createRelay(db, { from: { worktreeId: WT_A, instanceId: 'claude' }, to: { worktreeId: WT_B, instanceId: 'codex' }, hops: 1, expiresAt: NOW + 86_400_000, now: NOW });
    expect(stashRelayPayload(db, relay.id, 'reply', 'reply body', NOW)).toBe(true);
    return relay.id;
  }
  const deliveryState = (relayId: string): string | null =>
    (db.prepare('SELECT delivery_state FROM session_relays WHERE id = ?').get(relayId) as { delivery_state: string | null }).delivery_state;

  it('[outcome relay] indeterminate: held as uncertain — never queued to be typed again', async () => {
    const relayId = relayWithReply();
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'send target changed: tool-changed', fence: fenceOutcome('indeterminate') });
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(deliveryState(relayId)).not.toBeNull();
    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('[outcome relay] control, not-sent: the payload waits again (a refusal, as today)', async () => {
    const relayId = relayWithReply();
    sendUserMessage.mockResolvedValue({ ok: false, stage: 'send', error: 'send target changed: tool-changed', fence: fenceOutcome('not-sent') });
    await pumpRelayDeliveries();
    expect(deliveryState(relayId)).toBeNull();
    expect(getRelayPendingPayload(db, relayId)?.body).toBe('reply body');
  });
});

describe('b P3-3: the timer’s catch keeps [target_changed] for its own thrown refusal', () => {
  async function fireTimer(): Promise<string | null> {
    addPane(resolveSessionName('claude', WT_A, 'claude'), 'claude');
    const timer = createTimer(db, { worktreeId: WT_A, cliToolId: 'claude', instanceId: 'claude', message: 'timer body', delayMs: 0 });
    scheduleTimer(timer.id, WT_A, 0);
    await vi.waitFor(
      () => {
        const status = getTimerById(db, timer.id)?.status;
        if (status === 'pending' || status === 'sending' || getActiveTimerCount() > 0) throw new Error('timer still running');
      },
      { timeout: 20_000, interval: 20 },
    );
    return getTimerById(db, timer.id)?.error ?? null;
  }

  it('[outcome timer] the send throws this request’s refusal → `[target_changed] send target changed: tool-changed`', async () => {
    sendUserMessage.mockImplementation(async () => {
      throw new SendTargetChangedError('tool-changed', currentSendRequestId() as string);
    });
    expect(await fireTimer()).toBe('[target_changed] send target changed: tool-changed');
  }, 30_000);

  it('[outcome timer] control: another error thrown is kept as it was', async () => {
    sendUserMessage.mockImplementation(async () => {
      throw new Error('history write failed');
    });
    expect(await fireTimer()).toBe('history write failed');
  }, 30_000);
});
