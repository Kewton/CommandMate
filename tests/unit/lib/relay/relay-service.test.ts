/**
 * Unit tests for opening and withdrawing a relay (Issue #2377).
 *
 * The loop guard is the reason this file exists against a REAL database rather
 * than against `decideRelayCreation` alone: the chain test is a read of
 * `chat_messages` — "was the newest thing this session was told a relayed
 * message, and if so whose?" — and that read is the half of the guard a policy
 * unit test cannot exercise.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, relayRequestId } from '@/lib/db/chat-db';
import { getRelayById, markRelayDelivered } from '@/lib/db/relay-db';
import {
  findParentRelayHops,
  openRelay,
  readSessionRelays,
  withdrawRelay,
} from '@/lib/relay/relay-service';
import { MAX_RELAY_HOPS } from '@/lib/relay/relay-policy';

vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };
const C = { worktreeId: 'wt-c', instanceId: 'copilot' };

let db: Database.Database;

function insertWorktree(id: string, cliToolId = 'claude'): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, cliToolId, NOW);
}

/** The body a delivery puts in the requester's composer, and the reader echoes. */
const RELAYED_BODY = '[from Codex 2 / wt-b] done';

/** The row a delivered relay leaves in the requester's history. */
function seedRelayedUserMessage(
  worktreeId: string,
  cliToolId: 'claude' | 'codex' | 'copilot',
  instanceId: string,
  relayId: string,
  atMs = NOW
): void {
  createMessage(db, {
    worktreeId,
    role: 'user',
    content: RELAYED_BODY,
    messageType: 'relay',
    timestamp: new Date(atMs),
    requestId: relayRequestId(relayId),
    cliToolId,
    instanceId,
  });
}

/**
 * The SECOND row the same delivery produces (Issue #2387).
 *
 * The agent's own transcript reader records the prompt it was just handed, and
 * `recordUserTurn` cannot fold it into the relay row: that path only claims rows
 * with no `request_id`, and the relay row carries `relay:<id>`. So History gets
 * a `normal` twin of the relay row — measured 662ms behind it, same worktree,
 * same tool, same instance, same body, keyed `<tool>-prompt:<id>`.
 *
 * This is the row the loop guard used to trip over: it became the newest user
 * row, and a lookup that read only the newest row stopped seeing the parent.
 */
function seedTranscriptEchoRow(
  worktreeId: string,
  cliToolId: 'claude' | 'codex' | 'copilot',
  instanceId: string,
  atMs: number,
  content: string = RELAYED_BODY
): void {
  createMessage(db, {
    worktreeId,
    role: 'user',
    content,
    messageType: 'normal',
    timestamp: new Date(atMs),
    requestId: `${cliToolId}-prompt:bbc5c6d9-ea0`,
    cliToolId,
    instanceId,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  insertWorktree('wt-a', 'claude');
  insertWorktree('wt-b', 'codex');
  insertWorktree('wt-c', 'copilot');
});

afterEach(() => db.close());

describe('openRelay', () => {
  it('creates a pending relay at depth 1 and reports it', () => {
    const result = openRelay(db, { from: A, to: B, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.relay.state).toBe('pending');
    expect(result.relay.hops).toBe(1);
    expect(result.relay.expiresAt).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it('writes the "delegated, waiting" line into the requester\'s transcript', () => {
    const result = openRelay(db, { from: A, to: B, now: NOW });
    expect(result.ok).toBe(true);

    const rows = db
      .prepare(
        `SELECT content, role, request_id FROM chat_messages WHERE worktree_id = 'wt-a'`
      )
      .all() as Array<{ content: string; role: string; request_id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].request_id).toMatch(/^relay-sys:.*:requested$/);
    expect(rows[0].content).toContain('codex');
  });

  it('refuses a worktree that does not exist, and writes no line', () => {
    const result = openRelay(db, { from: A, to: { ...B, worktreeId: 'wt-nope' }, now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('RELAY_WORKTREE_NOT_FOUND');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }
    ).toEqual({ n: 0 });
  });

  it('refuses a second open relay in the same direction', () => {
    expect(openRelay(db, { from: A, to: B, now: NOW }).ok).toBe(true);
    const second = openRelay(db, { from: A, to: B, now: NOW });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.code).toBe('RELAY_DUPLICATE_PENDING');
  });

  it('permits the same pair again once the first one closed', () => {
    const first = openRelay(db, { from: A, to: B, now: NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    markRelayDelivered(db, first.relay.id, relayRequestId(first.relay.id), NOW);

    expect(openRelay(db, { from: A, to: B, now: NOW }).ok).toBe(true);
  });

  it('leaves no system line behind when it refuses', () => {
    openRelay(db, { from: A, to: B, now: NOW });
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }
    ).n;

    openRelay(db, { from: A, to: B, now: NOW });

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n
    ).toBe(before);
  });

  describe('the loop guard', () => {
    /** Put A in the position of "currently answering a relayed message". */
    function makeAAnsweringARelay(hops = 1): string {
      const parent = openRelay(db, { from: C, to: A, now: NOW });
      expect(parent.ok).toBe(true);
      if (!parent.ok) throw new Error('setup');
      db.prepare('UPDATE session_relays SET hops = ? WHERE id = ?').run(hops, parent.relay.id);
      seedRelayedUserMessage('wt-a', 'claude', 'claude', parent.relay.id);
      return parent.relay.id;
    }

    it('refuses by default when the newest user row arrived over a relay', () => {
      makeAAnsweringARelay();

      const result = openRelay(db, { from: A, to: B, now: NOW });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
    });

    it('permits it with allowRelayChain, one hop deeper', () => {
      makeAAnsweringARelay(1);

      const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.relay.hops).toBe(2);
    });

    it('stops at MAX_RELAY_HOPS even with the flag', () => {
      makeAAnsweringARelay(MAX_RELAY_HOPS);

      const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
    });

    it('is not a chain when the newest user row is an ordinary message', () => {
      makeAAnsweringARelay();
      createMessage(db, {
        worktreeId: 'wt-a',
        role: 'user',
        content: 'a human typed this',
        messageType: 'normal',
        timestamp: new Date(NOW + 1000),
        cliToolId: 'claude',
        instanceId: 'claude',
      });

      expect(openRelay(db, { from: A, to: B, now: NOW }).ok).toBe(true);
    });

    it('is still a chain when the session has since answered', () => {
      // An assistant row after the relayed prompt is the session REPLYING to it,
      // which is exactly the case the guard is about.
      makeAAnsweringARelay();
      createMessage(db, {
        worktreeId: 'wt-a',
        role: 'assistant',
        content: 'working on it',
        messageType: 'normal',
        timestamp: new Date(NOW + 1000),
        cliToolId: 'claude',
        instanceId: 'claude',
      });

      const result = openRelay(db, { from: A, to: B, now: NOW });
      expect(result.ok).toBe(false);
    });

    it('still refuses seconds later, once the reader has echoed the delivery', () => {
      // Issue #2387: the echo is the newest user row from 662ms after the
      // delivery onward, so a guard that read only the newest row stopped
      // refusing here — the chain block became a race the operator could win.
      makeAAnsweringARelay();
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', NOW + 662);

      const result = openRelay(db, { from: A, to: B, now: NOW + 5_000 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('RELAY_CHAIN_BLOCKED');
    });

    it('goes one hop deeper past the echo, not back to depth 1', () => {
      makeAAnsweringARelay(1);
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', NOW + 662);

      const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.relay.hops).toBe(2);
    });

    it('stops at MAX_RELAY_HOPS past the echo too', () => {
      makeAAnsweringARelay(MAX_RELAY_HOPS);
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', NOW + 662);

      const result = openRelay(db, { from: A, to: B, allowRelayChain: true, now: NOW + 5_000 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('RELAY_HOPS_EXCEEDED');
    });

    it('is not a chain when a human typed after the echo', () => {
      // The echo is stepped over; an ordinary message is not. #2377's rule —
      // the operator taking the session over ends the chain — survives #2387.
      makeAAnsweringARelay();
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', NOW + 662);
      createMessage(db, {
        worktreeId: 'wt-a',
        role: 'user',
        content: 'a human typed this',
        messageType: 'normal',
        timestamp: new Date(NOW + 5_000),
        cliToolId: 'claude',
        instanceId: 'claude',
      });

      expect(openRelay(db, { from: A, to: B, now: NOW + 6_000 }).ok).toBe(true);
    });

    it('scopes the guard to the instance, not the worktree', () => {
      makeAAnsweringARelay();

      // A DIFFERENT instance in the same worktree was never asked by a relay.
      const result = openRelay(db, {
        from: { worktreeId: 'wt-a', instanceId: 'claude-2' },
        to: B,
        now: NOW,
      });

      expect(result.ok).toBe(true);
    });
  });
});

describe('findParentRelayHops', () => {
  it('answers null for a session nobody relayed to', () => {
    expect(findParentRelayHops(db, A)).toBeNull();
  });

  it('answers null when the relay the row names has gone', () => {
    seedRelayedUserMessage('wt-a', 'claude', 'claude', 'a-relay-that-never-existed');

    expect(findParentRelayHops(db, A)).toBeNull();
  });

  it('reads the parent\'s depth', () => {
    const parent = openRelay(db, { from: C, to: A, now: NOW });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    db.prepare('UPDATE session_relays SET hops = 2 WHERE id = ?').run(parent.relay.id);
    seedRelayedUserMessage('wt-a', 'claude', 'claude', parent.relay.id);

    expect(findParentRelayHops(db, A)).toBe(2);
  });

  describe('the transcript reader\'s duplicate row (Issue #2387)', () => {
    /** Depth-2 parent, its delivered row, and the echo the reader adds. */
    function seedDeliveryWithEcho(echoAtMs = NOW + 662): void {
      const parent = openRelay(db, { from: C, to: A, now: NOW });
      expect(parent.ok).toBe(true);
      if (!parent.ok) throw new Error('setup');
      db.prepare('UPDATE session_relays SET hops = 2 WHERE id = ?').run(parent.relay.id);
      seedRelayedUserMessage('wt-a', 'claude', 'claude', parent.relay.id);
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', echoAtMs);
    }

    it('finds the parent behind the duplicate the reader wrote 662ms later', () => {
      // The exact ordering measured on 2026-09-07: `relay` at t, `normal` twin
      // at t+662ms. Reading only the newest user row answers null here, which
      // is what pinned every chained relay at hops = 1.
      seedDeliveryWithEcho();

      expect(findParentRelayHops(db, A)).toBe(2);
    });

    it('finds it however long the echo has been the newest row', () => {
      seedDeliveryWithEcho(NOW + 5_000);

      expect(findParentRelayHops(db, A)).toBe(2);
    });

    it('finds it behind a turn with more assistant rows than a row window holds', () => {
      // Why the lookback counts TURNS: one codex turn can emit dozens of
      // assistant rows, and a row-counted window would push both user rows out.
      seedDeliveryWithEcho();
      for (let i = 0; i < 60; i += 1) {
        createMessage(db, {
          worktreeId: 'wt-a',
          role: 'assistant',
          content: `step ${i}`,
          messageType: 'normal',
          timestamp: new Date(NOW + 1_000 + i),
          cliToolId: 'claude',
          instanceId: 'claude',
        });
      }

      expect(findParentRelayHops(db, A)).toBe(2);
    });

    it('answers null when an ordinary message follows the echo', () => {
      seedDeliveryWithEcho();
      createMessage(db, {
        worktreeId: 'wt-a',
        role: 'user',
        content: 'a human typed this',
        messageType: 'normal',
        timestamp: new Date(NOW + 5_000),
        cliToolId: 'claude',
        instanceId: 'claude',
      });

      expect(findParentRelayHops(db, A)).toBeNull();
    });

    it('answers null when the newer row carries a different body', () => {
      // Only a row that repeats the delivery is stepped over. Skipping every
      // `normal` row would report a parent for somebody else's message.
      seedDeliveryWithEcho();
      seedTranscriptEchoRow('wt-a', 'claude', 'claude', NOW + 900, 'something else entirely');

      expect(findParentRelayHops(db, A)).toBeNull();
    });
  });
});

describe('withdrawRelay', () => {
  it('cancels an open relay', () => {
    const opened = openRelay(db, { from: A, to: B, now: NOW });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const result = withdrawRelay(db, opened.relay.id, NOW);

    expect(result.ok).toBe(true);
    expect(getRelayById(db, opened.relay.id)?.state).toBe('cancelled');
  });

  it('reports a relay it has never heard of', () => {
    const result = withdrawRelay(db, 'nope', NOW);

    expect(result).toEqual({ ok: false, reason: 'not_found', relay: null });
  });

  it('refuses to report a delivered relay as cancelled', () => {
    const opened = openRelay(db, { from: A, to: B, now: NOW });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    markRelayDelivered(db, opened.relay.id, relayRequestId(opened.relay.id), NOW);

    const result = withdrawRelay(db, opened.relay.id, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_closed');
    expect(result.relay?.state).toBe('delivered');
  });
});

describe('readSessionRelays', () => {
  it('reports both ends of the session', () => {
    openRelay(db, { from: A, to: B, now: NOW });
    openRelay(db, { from: C, to: A, now: NOW });

    const summary = readSessionRelays(db, A);

    expect(summary.awaiting).toHaveLength(1);
    expect(summary.owed).toHaveLength(1);
  });
});
