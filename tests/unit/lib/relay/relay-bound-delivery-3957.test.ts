/**
 * A relay bound to its send (Issue #3957, PR 2 of 3): the delivery side.
 *
 * Every positive control below runs the same sequence against a LEGACY relay
 * (what every relay was before this PR) and shows the wrong reply going out;
 * the bound relay then shows the right one, or none. The send itself is driven
 * through the real binding (`reserveRelaySend` → the required boundary hook →
 * `finish`) against an in-memory SQLite, with fake timestamps; the transport,
 * the readiness check and the requester's composer are stubbed so each can be
 * held at its own point.
 *
 * Covered: T1 → T2 → sent (the earliest held candidate), S3 (a turn that ended
 * while the send queued), S5 (a send that failed), the overlap note and the
 * system line, the prompt (before the send, re-judged at `sent`, resolved
 * meanwhile), the second slot while a prompt notice is being typed, the
 * unclaimed prompt replaced, expiry over both slots, a relaunch during and
 * after the send, and the restart recovery at each intermediate state.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, findMessageByRequestId, RELAY_SYSTEM_REQUEST_ID_PREFIX } from '@/lib/db/chat-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import {
  createRelay,
  getRelayBinding,
  getRelayById,
  setRelayPendingReply,
  stashRelayPayload,
} from '@/lib/db/relay-db';
import { reserveRelaySend, type RelaySendBinding } from '@/lib/relay/relay-bind';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { beginAgentEventGeneration, clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { isRelayDeliveryClaimed } from '@/lib/relay/relay-delivery-claims';
import { withdrawRelay } from '@/lib/relay/relay-service';
import { clearWaitingEpisodes, observeWaitingEdge } from '@/lib/session/waiting-episode-state';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const CODEX_WORKER = { worktreeId: 'wt-b', cliToolId: 'codex' as const, instanceId: 'codex' };

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
  evaluateRelayAfterSend,
  notifyRelayPromptWaiting,
  notifyRelayTurnCompleted,
  pumpRelayDeliveries,
  recoverBoundRelays,
  resetRelayDeliveryState,
  sweepExpiredRelays,
} = await import('@/lib/relay/relay-delivery');

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

let turnSeq = 0;

/** A row the codex transcript reader wrote: a finished turn's answer. */
function seedReply(content: string, at: number, turnId?: string): string {
  turnSeq += 1;
  return createMessage(db, {
    worktreeId: 'wt-b',
    role: 'assistant',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    requestId: codexTurnRequestId(turnId ?? `turn-${turnSeq}`),
    cliToolId: 'codex',
    instanceId: 'codex',
  }).id;
}

/** A user row on the worker: this send's own, or somebody else's input. */
function seedUserRow(content: string, at: number): string {
  return createMessage(db, {
    worktreeId: 'wt-b',
    role: 'user',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    cliToolId: 'codex',
    instanceId: 'codex',
  }).id;
}

function seedPrompt(id: string, at: number, status: 'pending' | 'answered' = 'pending'): void {
  db.prepare(
    `INSERT INTO chat_messages
      (id, worktree_id, role, content, timestamp, message_type, prompt_data, cli_tool_id, instance_id, archived)
     VALUES (?, 'wt-b', 'assistant', 'Allow this?', ?, 'prompt', ?, 'codex', 'codex', 0)`
  ).run(
    id,
    at,
    JSON.stringify({
      type: 'multiple_choice',
      status,
      question: 'Allow Bash(rm -rf build)?',
      options: [
        { number: 1, label: 'Yes' },
        { number: 2, label: 'No' },
      ],
    })
  );
}

function openPromptEpisode(): void {
  observeWaitingEdge({ worktreeId: 'wt-b', cliToolId: 'codex', instanceId: 'codex', waiting: true, kind: 'prompt' });
}

function legacyRelay() {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
}

function boundRelay(expiresAt = NOW + DAY_MS) {
  return createRelay(db, { from: A, to: B, hops: 1, expiresAt, now: NOW, bindMode: 'bound' });
}

/** The turn record the send route would read at the boundary. */
let turnReading = { open: false, generation: null as number | null };

function reserve(relayId: string): RelaySendBinding {
  const result = reserveRelaySend(
    db,
    {
      relayId,
      worktreeId: 'wt-b',
      cliToolId: 'codex',
      instanceId: 'codex',
      hooksReportTurns: true,
      readTurn: () => turnReading,
    },
    NOW + 10
  );
  if (!result.ok) throw new Error(`reservation refused: ${result.refusal.code}`);
  result.binding.begin(turnReading.generation);
  return result.binding;
}

/** The body's first key, as the sender's `noteInputStart` runs the hook. */
function inputStarts(binding: RelaySendBinding, at: number): void {
  binding.hooks().beforeInput(new Date(at), 'input_start');
}

/** The send service answered ok: settle, then let the route's re-judgement run. */
function sendConfirmed(binding: RelaySendBinding, ownRowId: string): void {
  expect(binding.finish({ kind: 'sent', messageId: ownRowId, generationAfter: turnReading.generation })).toBe('sent');
  evaluateRelayAfterSend(binding.relayId);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pumpRelayDeliveries();
}

function deliveredBodies(): string[] {
  return sendUserMessage.mock.calls.map((call) => String((call[1] as { content: string }).content));
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  turnSeq = 0;
  turnReading = { open: false, generation: null };
  resetRelayDeliveryState();
  resetRelayServerBootId();
  clearWaitingEpisodes();
  clearAgentStopEvents();
  sendUserMessage.mockReset();
  sendUserMessage.mockResolvedValue({ ok: true, message: { id: 'm1' } });
  findRelayHoldReason.mockReset();
  findRelayHoldReason.mockResolvedValue(null);
});

afterEach(() => {
  clearWaitingEpisodes();
  clearAgentStopEvents();
  db.close();
});

describe('T1 done → T2 done → sent confirmed (Issue #3957)', () => {
  it('takes the EARLIEST held candidate after the boundary, not the newest', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('please review', NOW + 100);

    seedReply('T1 answer', NOW + 1_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    seedReply('T2 answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    // Held: nothing goes out before the send is confirmed.
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayBinding(db, relay.id)?.heldCandidates.map((c) => c.timestamp)).toEqual([NOW + 1_000, NOW + 2_000]);

    sendConfirmed(binding, own);
    await settle();

    expect(deliveredBodies()).toHaveLength(1);
    expect(deliveredBodies()[0]).toContain('T1 answer');
    expect(deliveredBodies()[0]).not.toContain('T2 answer');
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('with nothing held, waits for the next completion after the send', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();

    seedReply('the answer', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(deliveredBodies()[0]).toContain('the answer');
  });
});

describe('S3: a turn that ended while the send queued for the lock', () => {
  it('positive control — a LEGACY relay delivers that other turn', async () => {
    legacyRelay();
    seedReply('X: somebody else', NOW + 50);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()[0]).toContain('X: somebody else');
  });

  it('a bound relay drops it (before the boundary) and delivers its own', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    seedReply('X: somebody else', NOW + 50);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();

    seedReply('A: my answer', NOW + 4_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('A: my answer')]);
  });
});

describe('S5: a send that failed', () => {
  it('positive control — a LEGACY relay delivers a reply nobody asked it for', async () => {
    legacyRelay();
    seedReply('X answer', NOW + 500);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('a bound relay whose send failed before the boundary delivers nothing', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    seedReply('X answer', NOW + 500);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(binding.finish({ kind: 'failed', attempt: 'not-sent' })).toBe('not_sent');
    seedReply('Y answer', NOW + 900);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.sendState).toBe('failed');
  });

  it('a send that failed after the boundary, unplaced, is held as unknown (never delivered)', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    expect(binding.finish({ kind: 'failed', attempt: 'indeterminate' })).toBe('unknown');
    seedReply('maybe mine', NOW + 900);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'send_unknown' });
  });

  it('the transport sent but the history write failed → unknown / send_unknown', () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    expect(binding.finish({ kind: 'failed', attempt: 'sent' })).toBe('unknown');
    expect(getRelayById(db, relay.id)).toMatchObject({ sendState: 'unknown', holdReason: 'send_unknown' });
  });
});

describe('the overlap note and the system line', () => {
  it('a turn open at the boundary → overlap=later, note between header and reply', async () => {
    turnReading = { open: true, generation: null };
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    seedReply('folded answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    const [body] = deliveredBodies();
    const lines = body.split('\n');
    expect(lines[0]).toMatch(/^\[from .+ \/ wt-b\]$/);
    expect(lines[1]).toMatch(/^\[CommandMate relay\] .*overlap=later/);
    expect(lines.slice(2).join('\n')).toBe('folded answer');
    expect(getRelayById(db, relay.id)?.overlap).toBe('later');

    const line = findMessageByRequestId(db, 'wt-a', `${RELAY_SYSTEM_REQUEST_ID_PREFIX}${relay.id}:replied`);
    expect(line?.content).toContain('overlap=later');
  });

  it('another input proven between the boundary and the reply → overlap=earlier', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    seedUserRow('a human typed this', NOW + 500);
    seedReply('answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(getRelayById(db, relay.id)?.overlap).toBe('earlier');
    expect(deliveredBodies()[0]).toContain('overlap=earlier');
  });

  it('this send\'s own echo (same text, other id) proves nothing → unknown, never none', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    seedUserRow('mine', NOW + 700);
    seedReply('answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(getRelayById(db, relay.id)?.overlap).toBe('unknown');
    expect(deliveredBodies()[0]).toContain('overlap=unknown');
  });

  it('no open turn and no other input → overlap=none and no note (the header line is unchanged)', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    seedReply('clean answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(getRelayById(db, relay.id)?.overlap).toBe('none');
    expect(deliveredBodies()[0]).toMatch(/^\[from .+ \/ wt-b\] clean answer$/);
  });

  it('a tool whose hooks do not report turns → turn_unknown, overlap unknown (not none)', async () => {
    const relay = boundRelay();
    const result = reserveRelaySend(db, {
      relayId: relay.id,
      worktreeId: 'wt-b',
      cliToolId: 'codex',
      instanceId: 'codex',
      hooksReportTurns: false,
      readTurn: () => turnReading,
    }, NOW + 10);
    if (!result.ok) throw new Error('refused');
    result.binding.begin(null);
    inputStarts(result.binding, NOW + 100);
    sendConfirmed(result.binding, seedUserRow('mine', NOW + 100));
    seedReply('answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(getRelayById(db, relay.id)).toMatchObject({ obsState: 'turn_unknown', turnOpenAtSend: null, overlap: 'unknown' });
  });

  it('negative control — a legacy reply carries no note and no overlap', async () => {
    const relay = legacyRelay();
    seedReply('plain', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()[0]).toMatch(/^\[from .+ \/ wt-b\] plain$/);
    expect(getRelayById(db, relay.id)?.overlap).toBeNull();
  });
});

describe('the prompt, judged against the send', () => {
  it('positive control — a LEGACY relay is told about a dialog before its message went in', async () => {
    legacyRelay();
    seedPrompt('p-old', NOW + 50);
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it('a bound relay is not told before the send is confirmed', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    seedPrompt('p1', NOW + 500);
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
  });

  it('a dialog that opened before the confirmation and is still open is told at the confirmation', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    seedPrompt('p1', NOW + 500);
    openPromptEpisode();
    notifyRelayPromptWaiting(CODEX_WORKER);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    await settle();

    expect(deliveredBodies()).toEqual([expect.stringContaining('Allow Bash(rm -rf build)?')]);
    expect(getRelayById(db, relay.id)?.state).toBe('prompt');
  });

  it('a dialog resolved before the confirmation is not told', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    seedPrompt('p1', NOW + 500, 'answered');
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)?.state).toBe('pending');
  });

  it('a dialog shown before the boundary is not this request\'s', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    seedPrompt('p-before', NOW + 50);
    openPromptEpisode();
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('mine', NOW + 100));
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });
});

describe('the second slot: a reply finished while a prompt notice is pending', () => {
  it('a notice being typed: the reply waits, then goes out after it', async () => {
    const relay = legacyRelay();
    seedPrompt('p1', NOW + 500);
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );
    notifyRelayPromptWaiting(CODEX_WORKER);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(sendUserMessage).toHaveBeenCalledTimes(1);

    // The dialog was answered and the turn finished while the notice is typed.
    db.prepare(`UPDATE chat_messages SET prompt_data = json_set(prompt_data, '$.status', 'answered') WHERE id = 'p1'`).run();
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relay.id)?.pendingReply?.body).toContain('finished');

    release({ ok: true, message: { id: 'm-prompt' } });
    await settle();

    expect(deliveredBodies()).toHaveLength(2);
    expect(deliveredBodies()[1]).toContain('finished');
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
    expect(getRelayBinding(db, relay.id)?.pendingReply).toBeNull();
  });

  it('positive control of the old single slot: an unclaimed notice is REPLACED by the reply', async () => {
    const relay = legacyRelay();
    findRelayHoldReason.mockResolvedValue('requester-busy');
    seedPrompt('p1', NOW + 500);
    notifyRelayPromptWaiting(CODEX_WORKER);
    await settle();
    expect(getRelayById(db, relay.id)?.pendingKind).toBe('prompt');

    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    findRelayHoldReason.mockResolvedValue(null);
    await settle();

    expect(deliveredBodies()).toEqual([expect.stringContaining('finished')]);
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('expiry replaces both slots with the one notice', async () => {
    const relay = legacyRelay();
    const now = NOW + DAY_MS + 1;
    expect(stashRelayPayload(db, relay.id, 'prompt', 'notice', NOW + 1)).toBe(true);
    expect(
      setRelayPendingReply(db, relay.id, { candidateId: 'c', body: 'late reply', overlap: null, basis: 'legacy', payloadId: 'p' })
    ).toBe(true);

    expect(sweepExpiredRelays(db, now)).toBe(1);
    await settle();

    expect(deliveredBodies()).toHaveLength(1);
    expect(deliveredBodies()[0]).not.toContain('late reply');
    expect(getRelayBinding(db, relay.id)?.pendingReply).toBeNull();
    expect(getRelayById(db, relay.id)?.state).toBe('expired');
  });

  it('a stale delivery clears only its own payload (payload_id)', () => {
    const relay = legacyRelay();
    stashRelayPayload(db, relay.id, 'prompt', 'notice', NOW + 1, { payloadId: 'old' });
    db.prepare("UPDATE session_relays SET payload_id = 'new', pending_kind = 'reply', pending_body = 'reply' WHERE id = ?").run(relay.id);
    // The notice's delivery finishing late must not clear the reply.
    return import('@/lib/db/relay-db').then(({ clearRelayPending }) => {
      expect(clearRelayPending(db, relay.id, NOW + 2, 'old')).toBe(false);
      expect(getRelayById(db, relay.id)?.pendingKind).toBe('reply');
      expect(clearRelayPending(db, relay.id, NOW + 3, 'new')).toBe(true);
    });
  });
});

describe('the session relaunched', () => {
  it('during the send: observation invalid, held as generation_changed, nothing taken', async () => {
    turnReading = { open: false, generation: 1 };
    const relay = boundRelay();
    const binding = reserve(relay.id);
    turnReading = { open: false, generation: 2 };
    inputStarts(binding, NOW + 100);
    expect(binding.finish({ kind: 'sent', messageId: seedUserRow('m', NOW + 100), generationAfter: 2 })).toBe('sent');
    evaluateRelayAfterSend(relay.id);
    seedReply('from the new process', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)).toMatchObject({ obsState: 'invalid', holdReason: 'generation_changed', inputBoundaryAt: NOW + 100 });
  });

  it('after the send, before the reply: the new generation\'s reply is not matched', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('m', NOW + 100));
    beginAgentEventGeneration('wt-b', 'codex', 'codex', NOW + 1_000);
    seedReply('from the new process', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)).toMatchObject({ obsState: 'invalid', holdReason: 'generation_changed' });
  });
});

describe('restart recovery (each intermediate state)', () => {
  it('awaiting, not reserved: left alone', () => {
    const relay = boundRelay();
    resetRelayServerBootId();
    recoverBoundRelays(db, NOW + 5);
    expect(getRelayById(db, relay.id)).toMatchObject({ state: 'pending', sendState: 'awaiting', holdReason: null });
  });

  it('awaiting, reserved by the previous boot: proven unsent → failed and cancelled', () => {
    const relay = boundRelay();
    reserve(relay.id);
    resetRelayServerBootId();
    recoverBoundRelays(db, NOW + 5);
    expect(getRelayById(db, relay.id)).toMatchObject({
      state: 'cancelled',
      sendState: 'failed',
      holdReason: 'server_restarted_before_input',
    });
  });

  it('input_started by the previous boot: held as unknown / server_restarted', async () => {
    const relay = boundRelay();
    inputStarts(reserve(relay.id), NOW + 100);
    resetRelayServerBootId();
    recoverBoundRelays(db, NOW + 5);
    seedReply('?', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(getRelayById(db, relay.id)).toMatchObject({ state: 'pending', sendState: 'unknown', holdReason: 'server_restarted' });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('sent with no payload yet: observation invalid, the next reply is not taken', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('m', NOW + 100));
    resetRelayServerBootId();
    resetRelayDeliveryState();
    recoverBoundRelays(db, NOW + 5);
    seedReply('after the restart', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getRelayById(db, relay.id)).toMatchObject({ obsState: 'invalid', holdReason: 'server_restarted' });
  });

  it('sent with a decided payload: the delivery continues after the restart', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    findRelayHoldReason.mockResolvedValue('requester-busy');
    sendConfirmed(binding, seedUserRow('m', NOW + 100));
    seedReply('decided before the restart', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(getRelayById(db, relay.id)?.pendingKind).toBe('reply');

    resetRelayServerBootId();
    resetRelayDeliveryState();
    findRelayHoldReason.mockResolvedValue(null);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('decided before the restart')]);
  });

  it('the pump runs the recovery once per boot', async () => {
    const relay = boundRelay();
    reserve(relay.id);
    resetRelayServerBootId();
    await pumpRelayDeliveries();
    expect(getRelayById(db, relay.id)?.state).toBe('cancelled');
  });
});

describe('a reader that saves several turns and announces once (review P1)', () => {
  it('holds every turn of one announcement, and the earliest after the boundary is taken', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('please review', NOW + 100);

    // The codex reader backfills T1 and T2 in one capture; the gate announces once.
    seedReply('T1 answer', NOW + 1_000);
    seedReply('T2 answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relay.id)?.heldCandidates.map((c) => c.timestamp)).toEqual([NOW + 1_000, NOW + 2_000]);

    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('T1 answer')]);
    expect(deliveredBodies()[0]).not.toContain('T2 answer');
  });

  it('after the confirmation too: two turns saved at once deliver the earlier one', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    seedReply('first after the boundary', NOW + 1_000);
    seedReply('second', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('first after the boundary')]);
  });

  it('a turn that wrote two rows is one candidate, delivered by its newest row', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('go', NOW + 100);
    seedReply('narration', NOW + 1_000, 'turn-x');
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    seedReply('summary', NOW + 1_500, 'turn-x');
    seedReply('next turn', NOW + 3_000, 'turn-y');
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringMatching(/summary$/)]);
  });

  it('negative control: one turn, one announcement — delivered as before', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('go', NOW + 100);
    seedReply('only turn', NOW + 1_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('only turn')]);
  });
});

describe('a prompt notice whose delivery failed while a reply waited (review P2)', () => {
  async function blockPromptDelivery(): Promise<(value: unknown) => void> {
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    notifyRelayPromptWaiting(CODEX_WORKER);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    return release;
  }

  it('legacy: the reply replaces the failed notice and goes out; the notice does not', async () => {
    const relay = legacyRelay();
    seedPrompt('p1', NOW + 500);
    const release = await blockPromptDelivery();
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relay.id)?.pendingReply).not.toBeNull();

    release({ ok: false, stage: 'send', error: 'composer busy' });
    await settle();

    const bodies = deliveredBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('finished');
    expect(bodies[1]).not.toContain('Allow Bash');
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('bound: the same, after the send was confirmed', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    seedPrompt('p1', NOW + 500);
    const release = await blockPromptDelivery();
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });

    release({ ok: false, stage: 'prompt_waiting', error: 'requester on a dialog' });
    await settle();

    expect(deliveredBodies()[1]).toContain('finished');
    expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  });

  it('negative control: with the second slot empty the notice is retried as before', async () => {
    const relay = legacyRelay();
    seedPrompt('p1', NOW + 500);
    const release = await blockPromptDelivery();
    release({ ok: false, stage: 'send', error: 'composer busy' });
    await settle();

    expect(deliveredBodies()).toHaveLength(2);
    expect(deliveredBodies()[1]).toContain('Allow Bash(rm -rf build)?');
    expect(getRelayById(db, relay.id)?.state).toBe('prompt');
  });
});

describe('a backfill longer than a newest-first window (review 2, P2-1)', () => {
  /** T1, then one turn that wrote `rows` rows after it, interleaved with user rows. */
  function seedLongBackfill(rows: number, from: number): void {
    seedReply('T1 answer', from, 'turn-1');
    for (let i = 0; i < rows; i += 1) {
      seedUserRow(`follow-up ${i}`, from + 10 + i * 10);
      seedReply(`T2 part ${i}`, from + 15 + i * 10, 'turn-2');
    }
  }

  it('held before the confirmation: the first turn is taken though 40+ rows came after it', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('go', NOW + 100);
    seedLongBackfill(45, NOW + 1_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('T1 answer')]);
  });

  it('after the confirmation: the same', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    seedLongBackfill(45, NOW + 1_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('T1 answer')]);
  });

  it('negative control: a few rows — the first turn as before, and a turn is read by its newest row', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    seedLongBackfill(2, NOW + 1_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringMatching(/T1 answer$/)]);
  });
});

describe('the supersede after a failed prompt delivery throws (review 2, P2-2)', () => {
  it('the claim is released anyway: cancel and expiry still work', async () => {
    const relay = legacyRelay();
    seedPrompt('p1', NOW + 500);
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    notifyRelayPromptWaiting(CODEX_WORKER);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relay.id)?.pendingReply).not.toBeNull();
    // Make the supersede itself fail, in the database.
    db.exec(`CREATE TRIGGER refuse_supersede BEFORE UPDATE ON session_relays
      WHEN OLD.pending_kind = 'prompt' AND NEW.pending_kind = 'reply'
      BEGIN SELECT RAISE(ABORT, 'supersede refused'); END`);

    release({ ok: false, stage: 'send', error: 'composer busy' });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(isRelayDeliveryClaimed(relay.id)).toBe(false);
    expect(sweepExpiredRelays(db, NOW + DAY_MS + 1)).toBe(1);
  });

  it('the cancel is not refused as delivering', async () => {
    const relay = legacyRelay();
    seedPrompt('p1', NOW + 500);
    let release: (value: unknown) => void = () => {};
    sendUserMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    notifyRelayPromptWaiting(CODEX_WORKER);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    seedReply('finished', NOW + 3_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    db.exec(`CREATE TRIGGER refuse_supersede BEFORE UPDATE ON session_relays
      WHEN OLD.pending_kind = 'prompt' AND NEW.pending_kind = 'reply'
      BEGIN SELECT RAISE(ABORT, 'supersede refused'); END`);

    release({ ok: false, stage: 'send', error: 'composer busy' });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(withdrawRelay(db, relay.id, NOW + 10)).toMatchObject({ ok: true });
  });
});

describe('the scan bound and the turn order (review 3)', () => {
  it('P2-1: 500+ completion rows before the boundary do not hide the reply after it', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    // A long backfill of somebody else's turns, all before this send's input.
    for (let i = 0; i < 520; i += 1) seedReply(`old ${i}`, NOW + 1 + i * 0.1);
    inputStarts(binding, NOW + 200);
    const own = seedUserRow('go', NOW + 200);
    seedReply('my answer', NOW + 2_000);
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringContaining('my answer')]);
  });

  /** T1 writes at 1000 and 3000, T2 at 2000: T1 comes first by its first row. */
  function seedInterleavedTurns(): void {
    seedReply('T1 start', NOW + 1_000, 'turn-1');
    seedReply('T2 answer', NOW + 2_000, 'turn-2');
    seedReply('T1 final', NOW + 3_000, 'turn-1');
  }

  it('P2-2: held before the confirmation — T1 (by its first row), with its newest body', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    const own = seedUserRow('go', NOW + 100);
    seedInterleavedTurns();
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    expect(getRelayBinding(db, relay.id)?.heldCandidates.map((c) => c.timestamp)).toEqual([NOW + 1_000, NOW + 2_000]);
    sendConfirmed(binding, own);
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringMatching(/T1 final$/)]);
  });

  it('P2-2: after the confirmation — T1 too', async () => {
    const relay = boundRelay();
    const binding = reserve(relay.id);
    inputStarts(binding, NOW + 100);
    sendConfirmed(binding, seedUserRow('go', NOW + 100));
    seedInterleavedTurns();
    await notifyRelayTurnCompleted(CODEX_WORKER, { settled: true });
    await settle();
    expect(deliveredBodies()).toEqual([expect.stringMatching(/T1 final$/)]);
  });
});
