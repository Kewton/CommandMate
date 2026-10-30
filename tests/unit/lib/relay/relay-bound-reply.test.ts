/**
 * The reply/notice decisions split out of `relay-delivery` (Issue #3996).
 *
 * Imports the new module directly and pins the representative behaviour of
 * what moved: which row is B's reply, how finished turns are ordered, a legacy
 * relay's stash, the restart recovery, and that `relay-delivery` still hands
 * out the same functions under its own name.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, RELAY_SYSTEM_REQUEST_ID_PREFIX } from '@/lib/db/chat-db';
import { codexTurnRequestId } from '@/types/agent-transcript';
import { createRelay, getRelayById, getRelayPendingPayload } from '@/lib/db/relay-db';
import { resetRelayServerBootId } from '@/lib/relay/relay-boot';
import {
  findWorkerCompletions,
  findWorkerReply,
  recoverBoundRelays,
  requiresTurnRow,
  stashReplyForOpenRelays,
} from '@/lib/relay/relay-bound-reply';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const CODEX_WORKER = { worktreeId: 'wt-b', cliToolId: 'codex' as const, instanceId: 'codex' };

let db: Database.Database;

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

function insertWorktree(id: string, cliToolId: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

function seedRow(content: string, at: number, requestId?: string): string {
  return createMessage(db, {
    worktreeId: 'wt-b',
    role: 'assistant',
    content,
    messageType: 'normal',
    timestamp: new Date(at),
    requestId,
    cliToolId: 'codex',
    instanceId: 'codex',
  }).id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  resetRelayServerBootId();
});

afterEach(() => {
  db.close();
});

describe('relay-bound-reply (Issue #3996)', () => {
  it('reads a transcript tool\'s reply only from a turn row', () => {
    expect(requiresTurnRow('codex')).toBe(true);
    expect(requiresTurnRow('copilot')).toBe(false);

    const answer = seedRow('the answer', NOW + 100, codexTurnRequestId('t1'));
    // Newer, but a scrape (no turn marker) and CommandMate's own notice.
    seedRow('footer line', NOW + 200);
    seedRow('Reply from X', NOW + 300, `${RELAY_SYSTEM_REQUEST_ID_PREFIX}r1`);

    expect(findWorkerReply(db, CODEX_WORKER, NOW)?.id).toBe(answer);
    // A reply written before `since` answered somebody else.
    expect(findWorkerReply(db, CODEX_WORKER, NOW + 150)).toBeNull();
  });

  it('lists finished turns oldest first, each by its newest row', () => {
    seedRow('turn 1 narration', NOW + 100, codexTurnRequestId('t1'));
    const t1Summary = seedRow('turn 1 summary', NOW + 300, codexTurnRequestId('t1'));
    const t2 = seedRow('turn 2', NOW + 200, codexTurnRequestId('t2'));

    const turns = findWorkerCompletions(db, CODEX_WORKER, NOW);
    expect(turns.map((turn) => turn.row.id)).toEqual([t1Summary, t2]);
    expect(turns.map((turn) => turn.orderAt)).toEqual([NOW + 100, NOW + 200]);
    // From a later bound, a turn is placed by its first row at or after it.
    const later = findWorkerCompletions(db, CODEX_WORKER, NOW + 250);
    expect(later.map((turn) => [turn.row.id, turn.orderAt])).toEqual([[t1Summary, NOW + 300]]);
    expect(findWorkerCompletions(db, CODEX_WORKER, NOW + 350)).toEqual([]);
  });

  it('stashes the reply for a legacy relay once', () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW });
    seedRow('the answer', NOW + 100, codexTurnRequestId('t1'));

    expect(stashReplyForOpenRelays(db, CODEX_WORKER, NOW + 200)).toBe(1);
    const pending = getRelayPendingPayload(db, relay.id);
    expect(pending?.kind).toBe('reply');
    expect(pending?.body).toContain('the answer');
    // Two producers, one delivery.
    expect(stashReplyForOpenRelays(db, CODEX_WORKER, NOW + 300)).toBe(0);
  });

  it('leaves an unreserved bound relay alone on recovery', () => {
    const relay = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW, bindMode: 'bound' });

    expect(recoverBoundRelays(db, NOW + 10)).toBe(0);
    expect(getRelayById(db, relay.id)?.sendState).toBe('awaiting');
  });

  it('is still what relay-delivery exports under the same names', async () => {
    const delivery = await import('@/lib/relay/relay-delivery');
    expect(delivery.findWorkerReply).toBe(findWorkerReply);
    expect(delivery.recoverBoundRelays).toBe(recoverBoundRelays);
  });
});
