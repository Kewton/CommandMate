/**
 * Unit tests for the delivery engine (Issue #2377).
 *
 * What is asserted here is the set of properties the Issue names as its
 * concerns, and each one is written so a naive implementation fails it:
 *
 *  - **Deciding is not delivering.** A finished turn stashes; a busy requester
 *    keeps the stash and the retry delivers it. A test that only checked "the
 *    reply arrived" would pass against an implementation that interrupts the
 *    requester's own turn.
 *  - **Two producers, one delivery.** The Stop hook and the poller both announce
 *    the same finished turn.
 *  - **The quiet window** applies to a scrape-only completion and not to a
 *    transcript one.
 *  - **One expiry notice**, because the state change is guarded.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, relayRequestId, RELAY_SYSTEM_REQUEST_ID_PREFIX } from '@/lib/db/chat-db';
import {
  createRelay,
  getRelayById,
  listRelaysWithPendingPayload,
  stashRelayPayload,
} from '@/lib/db/relay-db';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

let db: Database.Database;

const sendUserMessage = vi.fn();
const findRelayHoldReason = vi.fn();

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...args: unknown[]) => sendUserMessage(...args),
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: (...args: unknown[]) => findRelayHoldReason(...args),
}));

const {
  findWorkerReply,
  notifyRelayPromptWaiting,
  notifyRelayTurnCompleted,
  pumpRelayDeliveries,
  resetRelayDeliveryState,
  sweepExpiredRelays,
} = await import('@/lib/relay/relay-delivery');

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

function seedReply(content: string, at = NOW + 1000): string {
  return createMessage(db, {
    worktreeId: 'wt-b',
    role: 'assistant',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    cliToolId: 'codex',
    instanceId: 'codex',
  }).id;
}

function newRelay(expiresAt = NOW + DAY_MS) {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt, now: NOW });
}

const CODEX_WORKER = { worktreeId: 'wt-b', cliToolId: 'codex' as const, instanceId: 'codex' };

/**
 * Let the fire-and-forget pump a notifier started run to completion, then run
 * one of our own.
 *
 * The production notifiers deliberately do NOT await their pump — a poller tick
 * must not block on a send — so a test that only awaited its own `pumpRelayDeliveries()`
 * would race the single-flight guard and see zero or one delivery depending on
 * microtask ordering.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pumpRelayDeliveries();
}

/** {@link settle} for a test running on fake timers, where `setImmediate` is faked too. */
async function settleFake(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await pumpRelayDeliveries();
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');

  resetRelayDeliveryState();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1' } });
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('findWorkerReply', () => {
  it('takes the newest assistant row', () => {
    seedReply('old', NOW + 1000);
    const newest = seedReply('new', NOW + 2000);

    expect(findWorkerReply(db, CODEX_WORKER, 0)?.id).toBe(newest);
  });

  it('steps over a prompt row', () => {
    const reply = seedReply('the answer', NOW + 1000);
    createMessage(db, {
      worktreeId: 'wt-b',
      role: 'assistant',
      content: 'Allow this?',
      messageType: 'prompt',
      timestamp: new Date(NOW + 2000),
      cliToolId: 'codex',
      instanceId: 'codex',
    });

    expect(findWorkerReply(db, CODEX_WORKER, 0)?.id).toBe(reply);
  });

  it('steps over a relay system row', () => {
    const reply = seedReply('the answer', NOW + 1000);
    createMessage(db, {
      worktreeId: 'wt-b',
      role: 'assistant',
      content: 'Delegated to X; waiting for the reply.',
      messageType: 'normal',
      timestamp: new Date(NOW + 2000),
      requestId: `${RELAY_SYSTEM_REQUEST_ID_PREFIX}r1:requested`,
      cliToolId: 'codex',
      instanceId: 'codex',
    });

    expect(findWorkerReply(db, CODEX_WORKER, 0)?.id).toBe(reply);
  });

  it('refuses a reply written before the relay existed', () => {
    seedReply('answered somebody else', NOW - 5000);

    expect(findWorkerReply(db, CODEX_WORKER, NOW)).toBeNull();
  });
});

describe('notifyRelayTurnCompleted (settled)', () => {
  it('stashes the reply and delivers it', async () => {
    const relay = newRelay();
    seedReply('here is the patch');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [, params] = sendUserMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(params.worktreeId).toBe('wt-a');
    expect(params.instanceId).toBe('claude');
    expect(params.messageType).toBe('relay');
    expect(params.requestId).toBe(relayRequestId(relay.id));
    expect(String(params.content)).toContain('[from ');
    expect(String(params.content)).toContain('here is the patch');

    const closed = getRelayById(db, relay.id);
    expect(closed?.state).toBe('delivered');
    expect(closed?.sentRequestId).toBe(relayRequestId(relay.id));
    expect(closed?.pendingKind).toBeNull();
  });

  it('holds ONE payload when both producers announce the same turn', async () => {
    const relay = newRelay();
    seedReply('done');
    // Held, so the two announcements are observable as stashes rather than
    // being swept up by the pump one of them starts.
    findRelayHoldReason.mockResolvedValue('generating');

    // The poller and the Stop hook, arriving on the same finished turn.
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });

    // One ledger row therefore one payload — the schema, not the guard, is what
    // makes a duplicate stash unrepresentable. What the guard buys is the
    // `false` that stops the second producer starting a second pump, which
    // `relay-db.test.ts` asserts directly.
    expect(listRelaysWithPendingPayload(db).filter((p) => p.relay.id === relay.id)).toHaveLength(
      1
    );
  });

  it('costs ONE delivery when the second producer arrives after the first landed', async () => {
    newRelay();
    seedReply('done');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    // The Stop hook, arriving after the poller's copy already went out.
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when no relay is waiting', async () => {
    seedReply('done');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('does not deliver a turn that predates the relay', async () => {
    seedReply('answered somebody else', NOW - 5000);
    newRelay();

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('writes the "reply from" line into the requester\'s transcript', async () => {
    newRelay();
    seedReply('done');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    const row = db
      .prepare(
        `SELECT request_id FROM chat_messages WHERE worktree_id = 'wt-a' AND request_id LIKE 'relay-sys:%'`
      )
      .get() as { request_id: string } | undefined;
    expect(row?.request_id).toMatch(/:replied$/);
  });
});

describe('holding a delivery while the requester is mid-turn', () => {
  it('keeps the stash rather than interrupting', async () => {
    const relay = newRelay();
    seedReply('done');
    findRelayHoldReason.mockResolvedValue('generating');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
    expect(listRelaysWithPendingPayload(db)).toHaveLength(1);
  });

  it('delivers on the next pump once the requester is idle', async () => {
    const relay = newRelay();
    seedReply('done');
    findRelayHoldReason.mockResolvedValue('generating');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();
    findRelayHoldReason.mockResolvedValue(null);
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('holds rather than losing the reply when the send is refused', async () => {
    const relay = newRelay();
    seedReply('done');
    sendUserMessage.mockResolvedValue({
      ok: false,
      stage: 'prompt_waiting',
      error: 'waiting on a prompt',
    });

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(getRelayById(db, relay.id)?.state).toBe('pending');
    expect(listRelaysWithPendingPayload(db)).toHaveLength(1);
  });

  it('does not hold a session that is merely idle', async () => {
    newRelay();
    seedReply('done');
    findRelayHoldReason.mockResolvedValue(null);

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe('notifyRelayTurnCompleted (scraped)', () => {
  it('waits out the quiet window before delivering', async () => {
    vi.useFakeTimers();
    newRelay();
    seedReply('half a fra');

    const pending = notifyRelayTurnCompleted(CODEX_WORKER, { settled: false });
    // Nothing yet: the frame has not been shown to be still.
    expect(listRelaysWithPendingPayload(db)).toHaveLength(0);
    expect(sendUserMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    await settleFake();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).toContain('half a fra');
  });

  it('delivers the LATER row when the pane kept moving', async () => {
    vi.useFakeTimers();
    newRelay();
    seedReply('half a fra', NOW + 1000);

    const pending = notifyRelayTurnCompleted(CODEX_WORKER, { settled: false });
    // Still inside the first quiet window: the pane is not done drawing.
    await vi.advanceTimersByTimeAsync(2_000);
    seedReply('half a frame, then the rest', NOW + 2000);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    await settleFake();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).toContain('then the rest');
  });

  it('does NOT wait when the completion came from a transcript', async () => {
    vi.useFakeTimers();
    newRelay();
    seedReply('done');

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });

    // No timer was advanced, and the payload is already decided.
    expect(
      listRelaysWithPendingPayload(db).length + sendUserMessage.mock.calls.length
    ).toBeGreaterThan(0);
  });
});

describe('notifyRelayPromptWaiting', () => {
  function seedPrompt(id: string, at = NOW + 1000): void {
    db.prepare(
      `INSERT INTO chat_messages
        (id, worktree_id, role, content, timestamp, message_type, prompt_data, cli_tool_id, instance_id, archived)
       VALUES (?, 'wt-b', 'assistant', 'Allow this?', ?, 'prompt', ?, 'codex', 'codex', 0)`
    ).run(
      id,
      at,
      JSON.stringify({
        type: 'multiple_choice',
        status: 'pending',
        question: 'Allow Bash(rm -rf build)?',
        options: [
          { number: 1, label: 'Yes' },
          { number: 2, label: 'No' },
        ],
      })
    );
  }

  it('tells the requester and moves the relay to prompt, keeping it open', async () => {
    const relay = newRelay();
    seedPrompt('p1');

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const [, params] = sendUserMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(params.content)).toContain('Allow Bash(rm -rf build)?');
    expect(String(params.content)).toContain('1) Yes');
    // Not the reply's request id: the relay is still open.
    expect(params.requestId).toBeUndefined();

    expect(getRelayById(db, relay.id)?.state).toBe('prompt');
  });

  it('tells them once however many polls observe the same dialog', async () => {
    newRelay();
    seedPrompt('p1');

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('tells them again for a DIFFERENT dialog', async () => {
    newRelay();
    seedPrompt('p1', NOW + 1000);

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    seedPrompt('p2', NOW + 2000);
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it('still delivers the reply once the dialog is answered', async () => {
    const relay = newRelay();
    seedPrompt('p1');

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    db.prepare(`UPDATE chat_messages SET prompt_data = ? WHERE id = 'p1'`).run(
      JSON.stringify({ type: 'multiple_choice', status: 'answered', question: 'x', options: [] })
    );
    seedReply('finished after the confirmation', NOW + 3000);

    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(2);
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('says nothing when no relay is waiting on this session', async () => {
    seedPrompt('p1');

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('says nothing when the newest prompt row is already answered', async () => {
    newRelay();
    db.prepare(
      `INSERT INTO chat_messages
        (id, worktree_id, role, content, timestamp, message_type, prompt_data, cli_tool_id, instance_id, archived)
       VALUES ('p1', 'wt-b', 'assistant', 'Allow this?', ?, 'prompt', ?, 'codex', 'codex', 0)`
    ).run(
      NOW + 1000,
      JSON.stringify({ type: 'yes_no', status: 'answered', question: 'q', options: ['yes', 'no'] })
    );

    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});

describe('sweepExpiredRelays', () => {
  it('expires a relay past its deadline and notifies once', async () => {
    const relay = newRelay(NOW - 1);

    expect(sweepExpiredRelays(db, NOW)).toBe(1);
    expect(sweepExpiredRelays(db, NOW)).toBe(0);
    expect(getRelayById(db, relay.id)?.state).toBe('expired');

    await pumpRelayDeliveries();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).toMatch(/expired|期限切れ/);
  });

  it('leaves a relay that is still in date alone', () => {
    const relay = newRelay(NOW + DAY_MS);

    expect(sweepExpiredRelays(db, NOW)).toBe(0);
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
  });

  it('replaces an undelivered reply with the expiry notice', async () => {
    const relay = newRelay(NOW - 1);
    stashRelayPayload(db, relay.id, 'reply', '[from Codex] too late', NOW);

    sweepExpiredRelays(db, NOW);
    await pumpRelayDeliveries();

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(sendUserMessage.mock.calls[0][1].content)).not.toContain('too late');
  });

  it('writes the expiry line into the requester\'s transcript', () => {
    newRelay(NOW - 1);

    sweepExpiredRelays(db, NOW);

    const row = db
      .prepare(
        `SELECT request_id FROM chat_messages WHERE worktree_id = 'wt-a' AND request_id LIKE 'relay-sys:%:expired'`
      )
      .get();
    expect(row).toBeDefined();
  });
});
