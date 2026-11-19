/**
 * Issue #4420 with the replies made by the real delivery, not seeded by hand
 * (docs/design/relay-rounds-window-4420.md §2.4, P3-Q6).
 *
 * Every reply here goes the production way: B's turn lands in B's history, the
 * completion is announced (`notifyRelayTurnCompleted`), the pump runs
 * `deliverOne`, and the real `sendUserMessage` writes the `relay` row into A's
 * history and closes the relay `delivered`. A's transcript reader is then run
 * over the same prompt (`recordUserTurn`, the writer of the pre-#2392 echo).
 * What is faked is the keystroke end only: the CLI tool's `sendMessage` (the
 * tmux send) is a stub, and the readiness capture of the requester's pane
 * answers "ready". The ledger, the loop guard, the policy and the history are
 * real; the database is a file under `os.tmpdir()`, removed after each test.
 *
 * - the Issue's report: after the reply, the 2nd and 3rd relay are not
 *   `RELAY_CHAIN_BLOCKED`;
 * - a fast loop between two sessions (A↔B, one round trip a minute, no person
 *   in between) is refused at the `MAX_RELAY_ROUNDS`-th reply, whichever way
 *   it was sent.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMigratedFileDb } from '../helpers/migrated-file-db';

const keystrokes = vi.hoisted(() => ({ sent: [] as Array<{ session: string; content: string }> }));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        name: `fake-${cliToolId}`,
        sendMessage: async (worktreeId: string, content: string) => {
          keystrokes.sent.push({ session: `${worktreeId}/${cliToolId}`, content });
        },
        getSessionName: (id: string) => `fake-${cliToolId}-${id}`,
      }),
    }),
  },
}));
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: vi.fn(),
  getActivePollers: vi.fn(() => []),
}));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/session/prompt-waiting-guard', () => ({
  isPromptWaiting: vi.fn().mockResolvedValue({ waiting: false }),
  promptWaitingMessage: () => 'prompt waiting',
}));
vi.mock('@/lib/relay/relay-readiness', () => ({
  findRelayHoldReason: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { createMessage, getMessages } from '@/lib/db/chat-db';
import { getRelayById } from '@/lib/db/relay-db';
import { recordUserTurn } from '@/lib/history/user-turn-recorder';
import { codexTurnRequestId, claudeTurnRequestId } from '@/types/agent-transcript';
import { notifyRelayTurnCompleted, resetRelayDeliveryState } from '@/lib/relay/relay-delivery';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import { findParentRelayHops, openRelay, type OpenRelayResult } from '@/lib/relay/relay-service';
import { MAX_RELAY_ROUNDS } from '@/lib/relay/relay-policy';
import type { RelayEndpoint, SessionRelay } from '@/lib/relay/types';

const START = Date.parse('2026-11-19T03:00:00.000Z');
const MINUTE = 60_000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'codex' };
const TOOL: Record<string, 'claude' | 'codex'> = { 'wt-a': 'claude', 'wt-b': 'codex', 'wt-c': 'codex' };

let dir: string;
let turnSeq = 0;

function insertWorktree(id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, path.join(dir, id), TOOL[id], START);
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `worker` finishes a turn answering whatever it was asked: its assistant row
 * lands in its history, the completion is announced, and the pump it starts
 * (`pumpRelayDeliveries` → `deliverOne`) delivers.
 * Then the requester's transcript reader reads the delivered prompt back.
 */
async function answer(worker: RelayEndpoint, requester: RelayEndpoint, text: string): Promise<void> {
  advance(1_000);
  turnSeq += 1;
  const sentBefore = keystrokes.sent.length;
  const tool = TOOL[worker.worktreeId];
  createMessage(db, {
    worktreeId: worker.worktreeId,
    role: 'assistant',
    content: text,
    messageType: 'normal',
    timestamp: new Date(Date.now()),
    requestId: tool === 'codex' ? codexTurnRequestId(`turn-${turnSeq}`) : claudeTurnRequestId(`turn-${turnSeq}`),
    cliToolId: tool,
    instanceId: worker.instanceId,
  });
  await notifyRelayTurnCompleted(
    { worktreeId: worker.worktreeId, cliToolId: tool, instanceId: worker.instanceId },
    { settled: true }
  );
  // The announcement started the pump (single-flight); wait for it to finish.
  for (let i = 0; i < 200 && keystrokes.sent.length === sentBefore; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flush();
  expect(keystrokes.sent.length).toBe(sentBefore + 1);

  // The requester's reader over the delivered prompt (#2392: writes nothing).
  const delivered = keystrokes.sent.at(-1);
  if (delivered) {
    advance(662);
    await recordUserTurn(
      { worktreeId: requester.worktreeId, cliToolId: TOOL[requester.worktreeId], instanceId: requester.instanceId },
      `${TOOL[requester.worktreeId]}-prompt:reader-${turnSeq}`,
      delivered.content,
      Date.now()
    );
  }
}

function open(from: RelayEndpoint, to: RelayEndpoint, allowRelayChain = false): OpenRelayResult {
  return openRelay(db, { from, to, allowRelayChain });
}

function mustOpen(from: RelayEndpoint, to: RelayEndpoint): SessionRelay {
  const result = open(from, to);
  if (!result.ok) throw new Error(`setup: ${result.refusal.code}`);
  return result.relay;
}

/** `from` asks `to` and `to` answers through the real delivery. */
async function roundTrip(from: RelayEndpoint, to: RelayEndpoint, n: number): Promise<SessionRelay> {
  const relay = mustOpen(from, to);
  await answer(to, from, `answer ${n} from ${to.worktreeId}`);
  expect(getRelayById(db, relay.id)?.state).toBe('delivered');
  return relay;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rounds-delivery-4420-'));
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  for (const id of ['wt-a', 'wt-b', 'wt-c']) insertWorktree(id);
  keystrokes.sent.length = 0;
  turnSeq = 0;
  resetRelayDeliveryState();
  resetRelayServerBootId();
});

afterEach(() => {
  resetRelayDeliveryState();
  resetRelayServerBootId();
  vi.useRealTimers();
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#4420 the Issue: send → reply → send again, with the reply made by deliverOne', () => {
  it('lets the 2nd and the 3rd relay through unflagged, at depth 1', async () => {
    await roundTrip(A, B, 1);

    // The delivery wrote the reply into A's history the production way.
    const aUsers = getMessages(db, 'wt-a', { limit: 20, cliToolId: 'claude', instanceId: 'claude' })
      .filter((row) => row.role === 'user');
    expect(aUsers.map((row) => row.messageType)).toEqual(['relay']);
    expect(aUsers[0].requestId).toMatch(/^relay:/);
    expect(keystrokes.sent).toHaveLength(1);
    expect(keystrokes.sent[0].session).toBe('wt-a/claude');

    const second = open(A, B);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.relay.hops).toBe(1);
    await answer(B, A, 'answer 2');

    const third = open(A, C);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.relay.hops).toBe(1);
    expect(findParentRelayHops(db, A)).toBeNull();
  });
});

describe('#4420 a fast loop between two sessions stops at MAX_RELAY_ROUNDS', () => {
  it('A↔B, one round trip a minute and nobody typing: refused at the MAX_RELAY_ROUNDS-th reply, flag or not', async () => {
    for (let n = 1; n <= MAX_RELAY_ROUNDS; n += 1) {
      advance(MINUTE);
      await roundTrip(A, B, n);
      if (n < MAX_RELAY_ROUNDS) {
        // B asks back, A answers: B's own count grows the same way.
        await roundTrip(B, A, n);
      }
    }

    const refused = open(A, B);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
    const flagged = open(A, B, true);
    expect(flagged.ok).toBe(false);
    if (!flagged.ok) expect(flagged.refusal.code).toBe('RELAY_HOPS_EXCEEDED');

    // B received MAX - 1 replies: one more round trip still goes for B.
    expect(open(B, A).ok).toBe(true);
  });

  it('the same sessions at one round trip every four minutes are never refused (known limit Q-1)', async () => {
    for (let n = 1; n <= MAX_RELAY_ROUNDS + 2; n += 1) {
      advance(4 * MINUTE);
      await roundTrip(A, B, n);
    }

    expect(open(A, B).ok).toBe(true);
  });
});
