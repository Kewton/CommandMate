/**
 * Migration v72: the ask correlation ledger (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.1・§3.4).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { v72_migrations } from '@/lib/db/migrations/v72-ask-correlations';
import {
  ASK_CORRELATION_MAX_ROWS_PER_WORKTREE,
  ASK_CORRELATION_RETENTION_MS,
  getAskCorrelation,
  noteAskEvidence,
  pruneAskCorrelations,
  recordAskNativeInput,
  recordAskSendOutcome,
  reserveAsk,
  settleAskAttribution,
} from '@/lib/db/ask-correlation-db';

const ASK = '11111111-1111-4111-8111-111111111111';

describe('migration v72: ask correlations', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('w', 'w', '/p', '/r', 'r')`).run();
  });
  afterEach(() => db.close());

  const reserve = (askId = ASK, digest = 'd1', now?: number) =>
    reserveAsk(db, { askId, worktreeId: 'w', instanceId: 'claude', cliToolId: 'claude', bodyDigest: digest, now });

  it('lands on v72 after v71', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(72);
    expect(v72_migrations.map((migration) => migration.version)).toEqual([72]);
  });

  it('is a worktree child by its worktree_id column (rename and delete follow it)', () => {
    expect(getWorktreeChildTables(db)).toContainEqual({ table: 'ask_correlations', column: 'worktree_id' });
  });

  it('reserves once; the same body again is `existing`, another body `conflict`', () => {
    expect(reserve().kind).toBe('reserved');
    expect(reserve().kind).toBe('existing');
    expect(reserve(ASK, 'other').kind).toBe('conflict');
    expect(getAskCorrelation(db, ASK)).toMatchObject({ sendState: 'reserved', attributionState: 'pending', notified: false });
  });

  it('records the send outcome once and never rewrites a terminal attribution (M6)', () => {
    reserve();
    expect(recordAskSendOutcome(db, ASK, { sendState: 'sent', sentMessageId: 'm', turnOpenAtSend: true })).toBe(true);
    expect(recordAskSendOutcome(db, ASK, { sendState: 'not_sent' })).toBe(false);
    expect(getAskCorrelation(db, ASK)).toMatchObject({ sendState: 'sent', sentMessageId: 'm', turnOpenAtSend: true });
    expect(settleAskAttribution(db, ASK, { state: 'matched', reason: null, assistantMessageIds: ['a1'], notified: true })).toBe(true);
    expect(settleAskAttribution(db, ASK, { state: 'ambiguous', reason: 'shared_turn' })).toBe(false);
    expect(getAskCorrelation(db, ASK)).toMatchObject({ attributionState: 'matched', assistantMessageIds: ['a1'], notified: true });
  });

  it('H2: not_sent is terminal in the same statement (unmatched/not_sent)', () => {
    reserve();
    recordAskSendOutcome(db, ASK, { sendState: 'not_sent' });
    expect(getAskCorrelation(db, ASK)).toMatchObject({ sendState: 'not_sent', attributionState: 'unmatched', reason: 'not_sent' });
    expect(settleAskAttribution(db, ASK, { state: 'matched', reason: null })).toBe(false);
  });

  it('I8: carried evidence is kept on a pending row only', () => {
    reserve();
    expect(noteAskEvidence(db, ASK, 'duplicate')).toBe(true);
    expect(noteAskEvidence(db, ASK, 'absorbed')).toBe(true);
    expect(getAskCorrelation(db, ASK)).toMatchObject({ duplicateSeen: true, absorbedSeen: true });
    settleAskAttribution(db, ASK, { state: 'unmatched', reason: 'envelope_duplicated' });
    expect(noteAskEvidence(db, ASK, 'absorbed')).toBe(false);
  });

  it('§3.6.5: a settlement for one native input does not take a row that names another (another process recorded it)', () => {
    reserve();
    recordAskNativeInput(db, ASK, { nativeInputId: 'p-other', nativeSessionId: 's' });
    expect(settleAskAttribution(db, ASK, { state: 'matched', reason: null, expectedInputId: 'p-mine' })).toBe(false);
    expect(settleAskAttribution(db, ASK, { state: 'matched', reason: null, replyDigest: 'd', replyLength: 1, expectedInputId: 'p-other' })).toBe(true);
    expect(getAskCorrelation(db, ASK)).toMatchObject({ attributionState: 'matched', replyDigest: 'd', replyLength: 1 });
  });

  it('goes with its worktree', () => {
    reserve();
    db.prepare(`DELETE FROM worktrees WHERE id = 'w'`).run();
    expect(getAskCorrelation(db, ASK)).toBeNull();
  });

  it('prunes by age and keeps at most the newest rows per worktree (R1)', () => {
    const now = 10 * ASK_CORRELATION_RETENTION_MS;
    reserve('22222222-2222-4222-8222-222222222222', 'd', now - ASK_CORRELATION_RETENTION_MS - 1);
    for (let i = 0; i < ASK_CORRELATION_MAX_ROWS_PER_WORKTREE + 2; i += 1) {
      reserve(`33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, 'd', now - 1000 + i);
    }
    pruneAskCorrelations(db, 'w', now);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM ask_correlations').get() as { n: number }).n;
    expect(count).toBe(ASK_CORRELATION_MAX_ROWS_PER_WORKTREE);
    expect(getAskCorrelation(db, '22222222-2222-4222-8222-222222222222')).toBeNull();
  });

  it('rolls back by dropping the table', () => {
    v72_migrations[0].down!(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ask_correlations'").get()).toBeUndefined();
  });
});
