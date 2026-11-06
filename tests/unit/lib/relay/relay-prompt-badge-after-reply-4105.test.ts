/**
 * The worker-prompt badge (`state: 'prompt'`) reads as a record, not as
 * "the worker is still waiting" (Issue #4105, consistency review P2).
 *
 * Replacing the prompt notice with the reply (`replaceRelayPromptWithReply`)
 * and promoting a waiting reply keep `state = 'prompt'` until the relay
 * closes, so the badge stays after B answered. Fix (i): the wording only
 * says a confirmation was recorded. The relay is driven through the real
 * ledger (in-memory DB) into each shape, read back with `getRelayById`, and
 * the badge the roster and the chat strip resolve is looked up in both
 * dictionaries.
 *
 * Positive: after the reply took the notice's place, no text of that badge
 * says B is waiting now (failed before the fix: "相手が確認待ち…",
 * "{alias} が確認待ち", "Worker awaiting confirmation", "is waiting for a
 * confirmation"). Negative: before the replacement the same `prompt` badge is
 * resolved with the same keys (its meaning — B stopped on a confirmation, a
 * notice was queued — unchanged).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRelay, getRelayById, markRelayPromptNotified } from '@/lib/db/relay-db';
import { getRelayPendingPayload, stashRelayPayload } from '@/lib/db/relay-bind-db';
import { replaceRelayPromptWithReply } from '@/lib/db/relay-bind-db-pending';
import { resolveRelayBadges, resolveRelayStrip, type RelayBadge } from '@/lib/relay/relay-badges';
import en from '../../../../locales/en/worktree.json';
import ja from '../../../../locales/ja/worktree.json';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

const dictionaries: Array<[string, Record<string, string>]> = [
  ['en', (en as unknown as Record<string, Record<string, string>>).relay],
  ['ja', (ja as unknown as Record<string, Record<string, string>>).relay],
];

/** Present-tense "B is waiting" in either language. */
const STILL_WAITING = [/が確認待ち(?!で止まった|を記録)/, /相手が確認待ち/, /awaiting confirmation/i, /is waiting for a confirmation/i];

function open(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  for (const id of ['wt-a', 'wt-b']) {
    db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(id, id, `/tmp/${id}`, NOW);
  }
  return db;
}

function promptBadgeTexts(db: Database.Database, id: string): { badge: RelayBadge; texts: string[] } {
  const relay = getRelayById(db, id);
  expect(relay?.state).toBe('prompt');
  const badges = resolveRelayBadges({ owed: [], awaiting: [relay!], aliasOf: (e) => e.instanceId });
  const badge = badges.find((b) => b.tone === 'prompt');
  expect(badge).toBeDefined();
  const strip = resolveRelayStrip(badges);
  expect(strip?.key).toBe('stripPrompt');
  const texts = dictionaries.flatMap(([, d]) => [d[badge!.key], d[badge!.titleKey], d[strip!.key]]);
  for (const text of texts) expect(typeof text).toBe('string');
  return { badge: badge!, texts };
}

describe('the worker-prompt badge after the reply replaced the notice (Issue #4105 P2)', () => {
  let db: Database.Database;
  let relayId: string;

  beforeEach(() => {
    db = open();
    relayId = createRelay(db, { from: A, to: B, hops: 1, expiresAt: NOW + DAY_MS, now: NOW }).id;
    markRelayPromptNotified(db, relayId, 'sig-1', NOW + 1);
    expect(stashRelayPayload(db, relayId, 'prompt', 'the notice', NOW + 2, { payloadId: 'p1' })).toBe(true);
  });
  afterEach(() => db.close());

  it('positive: replaced by the reply, state stays prompt and no text says B is still waiting', () => {
    expect(
      replaceRelayPromptWithReply(
        db,
        relayId,
        'p1',
        { candidateId: 'msg-r1', body: 'the reply', overlap: 'none', basis: 'test', payloadId: 'r1' },
        NOW + 3
      )
    ).toBe('reply');
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'reply', payloadId: 'r1' });

    const { texts } = promptBadgeTexts(db, relayId);
    for (const text of texts) {
      for (const pattern of STILL_WAITING) expect(text, text).not.toMatch(pattern);
    }
    // The title says outright that it may have been answered.
    const [enTitle, jaTitle] = dictionaries.map(([, d]) => d.promptTitle);
    expect(enTitle).toMatch(/does not say the session is still waiting/);
    expect(jaTitle).toContain('今も確認待ちかどうかは表しません');
  });

  it('negative: before the replacement the same prompt badge, same keys, notice queued', () => {
    expect(getRelayPendingPayload(db, relayId)).toMatchObject({ kind: 'prompt', payloadId: 'p1' });
    const { badge } = promptBadgeTexts(db, relayId);
    expect(badge).toMatchObject({ tone: 'prompt', key: 'badgePrompt', titleKey: 'promptTitle', count: 1 });
    const [enTitle, jaTitle] = dictionaries.map(([, d]) => d.promptTitle);
    expect(enTitle).toMatch(/stopped on a confirmation/);
    expect(enTitle).toMatch(/queued/);
    expect(jaTitle).toContain('確認待ちで止ま');
    expect(jaTitle).toContain('待ち行列に入れ');
  });
});
