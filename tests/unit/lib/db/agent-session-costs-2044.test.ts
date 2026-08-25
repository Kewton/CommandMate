/**
 * The agent session cost ledger (Issue #2044)
 *
 * Migration v58, `agent-session-cost-db.ts` and `agent-session-cost-sampler.ts`.
 *
 * The load-bearing claim, and the one most of these tests exist to pin, is that
 * **writes overwrite and never accumulate**: opencode publishes `Session.cost`
 * and `Session.tokens` as running totals for the session, so a sampler that
 * added its samples would multiply a long conversation's cost by however many
 * times it happened to look. That was measured, not assumed — see
 * `docs/design/opencode-server-live-verification.md` §15 and the arithmetic
 * asserted in `opencode-json-output-2044.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '@/lib/db/db-migrations';
import {
  recordAgentSessionCost,
  getAgentSessionCostsByDate,
  getDailyAgentCostSummary,
  deleteAgentSessionCostsByDate,
  type AgentSessionCostInput,
} from '@/lib/db/agent-session-cost-db';
import {
  sampleAgentSessionCosts,
  listTelemetryTargets,
  localDateKey,
  startAgentSessionCostSampler,
  stopAgentSessionCostSampler,
} from '@/lib/db/agent-session-cost-sampler';
import {
  recordAgentSessionTelemetry,
  resetAgentSessionTelemetry,
  type AgentSessionRecord,
} from '@/lib/hooks/agent-session-telemetry';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';

let db: Database.Database;

const DATE = '2026-08-25';

function openDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  runMigrations(testDb);
  return testDb;
}

function seedWorktree(id: string, name = id): void {
  db.prepare(
    'INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)'
  ).run(id, name, `/repos/${id}`, Date.now());
}

function costInput(overrides: Partial<AgentSessionCostInput> = {}): AgentSessionCostInput {
  return {
    sessionId: 'ses_one',
    worktreeId: 'wt-a',
    cliToolId: 'opencode',
    instanceId: null,
    date: DATE,
    title: 'cm-2044-probe',
    agent: 'plan',
    model: 'claude-sonnet-4.6',
    provider: 'github-copilot',
    cost: 0.03754035,
    tokensInput: 3,
    tokensOutput: 174,
    tokensReasoning: 0,
    tokensCacheRead: 8367,
    tokensCacheWrite: 8643,
    observedAt: 1_787_648_888_000,
    ...overrides,
  };
}

function telemetry(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    id: 'ses_one',
    title: 'cm-2044-probe',
    agent: 'plan',
    model: 'claude-sonnet-4.6',
    provider: 'github-copilot',
    cost: 0.03754035,
    tokens: { input: 3, output: 174, reasoning: 0, cacheRead: 8367, cacheWrite: 8643, total: null },
    at: new Date(`${DATE}T10:00:00`).getTime(),
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb();
  resetAgentSessionTelemetry();
  stopAgentSessionCostSampler();
});

afterEach(() => {
  stopAgentSessionCostSampler();
  resetAgentSessionTelemetry();
  db.close();
});

describe('migration v58 (Issue #2044)', () => {
  it('brings the schema to the pinned version', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(58);
  });

  it('creates agent_session_costs with session_id as the key', () => {
    const info = db.prepare("PRAGMA table_info('agent_session_costs')").all() as Array<{
      name: string;
      pk: number;
      notnull: number;
    }>;
    expect(info.find((c) => c.name === 'session_id')?.pk).toBe(1);
    expect(info.find((c) => c.name === 'worktree_id')?.notnull).toBe(1);

    // Every spend column stays nullable: null means "the agent did not say".
    for (const column of ['cost', 'tokens_input', 'tokens_output', 'tokens_cache_read']) {
      expect(info.find((c) => c.name === column)?.notnull, column).toBe(0);
    }
  });

  it('is discovered as a worktree child table, so renames and deletes follow it', () => {
    const children = getWorktreeChildTables(db);
    expect(children).toContainEqual({ table: 'agent_session_costs', column: 'worktree_id' });
  });

  it('declares no BEFORE UPDATE guard, because the ledger must be overwritable', () => {
    const triggers = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'agent_session_costs'")
      .all();
    expect(triggers).toEqual([]);
  });
});

describe('recordAgentSessionCost (Issue #2044)', () => {
  beforeEach(() => seedWorktree('wt-a'));

  it('inserts a row', () => {
    expect(recordAgentSessionCost(db, costInput())).toBe(true);
    const rows = getAgentSessionCostsByDate(db, DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(0.03754035);
    expect(rows[0].tokensCacheWrite).toBe(8643);
  });

  it('overwrites rather than accumulates on a second sample', () => {
    recordAgentSessionCost(db, costInput({ cost: 0.03, tokensOutput: 100 }));
    recordAgentSessionCost(db, costInput({ cost: 0.05, tokensOutput: 174, observedAt: 2_000_000 }));

    const rows = getAgentSessionCostsByDate(db, DATE);
    expect(rows).toHaveLength(1);
    // 0.05, not 0.08 — the number is already cumulative.
    expect(rows[0].cost).toBe(0.05);
    expect(rows[0].tokensOutput).toBe(174);
    expect(rows[0].observedAt).toBe(2_000_000);
  });

  it('keeps the opening day when a session is re-sampled after midnight', () => {
    recordAgentSessionCost(db, costInput());
    recordAgentSessionCost(db, costInput({ date: '2026-08-26', observedAt: 3_000_000 }));

    expect(getAgentSessionCostsByDate(db, '2026-08-26')).toHaveLength(0);
    const rows = getAgentSessionCostsByDate(db, DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeenAt).toBe(1_787_648_888_000);
  });

  it('keeps null distinct from zero', () => {
    recordAgentSessionCost(db, costInput({ cost: null, tokensInput: 0 }));
    const [row] = getAgentSessionCostsByDate(db, DATE);
    expect(row.cost).toBeNull();
    expect(row.tokensInput).toBe(0);
  });

  it('is refused for a worktree that does not exist', () => {
    expect(() => recordAgentSessionCost(db, costInput({ worktreeId: 'ghost' }))).toThrow();
  });

  it('follows the worktree when a session moves to a renamed id', () => {
    seedWorktree('wt-b');
    recordAgentSessionCost(db, costInput());
    recordAgentSessionCost(db, costInput({ worktreeId: 'wt-b', observedAt: 2_000_000 }));
    expect(getAgentSessionCostsByDate(db, DATE)[0].worktreeId).toBe('wt-b');
  });

  it('loses its rows when the worktree is deleted (ON DELETE CASCADE)', () => {
    recordAgentSessionCost(db, costInput());
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-a');
    expect(getAgentSessionCostsByDate(db, DATE)).toHaveLength(0);
  });
});

describe('getDailyAgentCostSummary (Issue #2044)', () => {
  beforeEach(() => {
    seedWorktree('wt-a');
    seedWorktree('wt-b');
  });

  it('reproduces the measured `opencode stats` totals', () => {
    // The two sessions of the §15 probe, as `GET /session` reported them.
    recordAgentSessionCost(db, costInput({
      sessionId: 'ses_fc7d263fdffeLvyqq82v94FpQ1',
      cost: 0.03754035,
      tokensInput: 3, tokensOutput: 174, tokensReasoning: 0,
      tokensCacheRead: 8367, tokensCacheWrite: 8643,
    }));
    recordAgentSessionCost(db, costInput({
      sessionId: 'ses_fc7d2c1daffeoHDeorpPDSsbrN',
      cost: 0.030399,
      tokensInput: 3, tokensOutput: 7, tokensReasoning: 0,
      tokensCacheRead: 0, tokensCacheWrite: 8076,
    }));

    const { total } = getDailyAgentCostSummary(db, DATE);
    // `opencode stats --project ""` printed: Total Cost $0.07, Input 6,
    // Output 181, Cache Read 8.4K, Cache Write 16.7K.
    expect(total.sessions).toBe(2);
    expect(total.cost).toBeCloseTo(0.06793935, 10);
    expect(total.tokensInput).toBe(6);
    expect(total.tokensOutput).toBe(181);
    expect(total.tokensCacheRead).toBe(8367);
    expect(total.tokensCacheWrite).toBe(16719);
  });

  it('groups by worktree, most expensive first', () => {
    recordAgentSessionCost(db, costInput({ sessionId: 's1', worktreeId: 'wt-a', cost: 0.01 }));
    recordAgentSessionCost(db, costInput({ sessionId: 's2', worktreeId: 'wt-b', cost: 0.09 }));
    recordAgentSessionCost(db, costInput({ sessionId: 's3', worktreeId: 'wt-b', cost: 0.01 }));

    const { worktrees } = getDailyAgentCostSummary(db, DATE);
    expect(worktrees.map((row) => row.worktreeId)).toEqual(['wt-b', 'wt-a']);
    expect(worktrees[0].sessions).toBe(2);
    expect(worktrees[0].cost).toBeCloseTo(0.1, 10);
  });

  it('reports null rather than zero when nobody said what it cost', () => {
    recordAgentSessionCost(db, costInput({ cost: null, tokensInput: null }));
    const { total, worktrees } = getDailyAgentCostSummary(db, DATE);
    expect(worktrees[0].cost).toBeNull();
    expect(total.cost).toBeNull();
    expect(total.sessions).toBe(1);
  });

  it('filters by CLI tool when asked', () => {
    recordAgentSessionCost(db, costInput({ sessionId: 's1', cliToolId: 'opencode', cost: 1 }));
    recordAgentSessionCost(db, costInput({ sessionId: 's2', cliToolId: 'claude', cost: 2 }));
    expect(getDailyAgentCostSummary(db, DATE, 'opencode').total.cost).toBe(1);
    expect(getDailyAgentCostSummary(db, DATE).total.cost).toBe(3);
  });

  it('answers an empty summary for a day with no sessions', () => {
    const summary = getDailyAgentCostSummary(db, '2026-01-01');
    expect(summary.worktrees).toEqual([]);
    expect(summary.total.sessions).toBe(0);
    expect(summary.total.cost).toBeNull();
  });

  it('deleteAgentSessionCostsByDate clears one day only', () => {
    recordAgentSessionCost(db, costInput({ sessionId: 's1' }));
    recordAgentSessionCost(db, costInput({ sessionId: 's2', date: '2026-08-24' }));
    expect(deleteAgentSessionCostsByDate(db, DATE)).toBe(1);
    expect(getAgentSessionCostsByDate(db, '2026-08-24')).toHaveLength(1);
  });
});

describe('the sampler (Issue #2044)', () => {
  beforeEach(() => seedWorktree('wt-a'));

  it('lists nothing when no instance has reported', () => {
    expect(listTelemetryTargets()).toEqual([]);
    expect(sampleAgentSessionCosts(db, Date.now())).toBe(0);
  });

  it('copies a primary-instance record into the ledger', () => {
    recordAgentSessionTelemetry({ worktreeId: 'wt-a', cliToolId: 'opencode' }, telemetry());
    expect(listTelemetryTargets()).toEqual([
      { worktreeId: 'wt-a', cliToolId: 'opencode', instanceId: undefined },
    ]);

    expect(sampleAgentSessionCosts(db, Date.now())).toBe(1);
    const [row] = getAgentSessionCostsByDate(db, DATE);
    expect(row.sessionId).toBe('ses_one');
    expect(row.instanceId).toBeNull();
    expect(row.cost).toBe(0.03754035);
    expect(row.agent).toBe('plan');
  });

  it('keeps a named instance distinct from the primary one', () => {
    recordAgentSessionTelemetry(
      { worktreeId: 'wt-a', cliToolId: 'opencode', instanceId: 'opencode-2' },
      telemetry({ id: 'ses_two' }),
    );
    expect(listTelemetryTargets()).toEqual([
      { worktreeId: 'wt-a', cliToolId: 'opencode', instanceId: 'opencode-2' },
    ]);
    sampleAgentSessionCosts(db, Date.now());
    expect(getAgentSessionCostsByDate(db, DATE)[0].instanceId).toBe('opencode-2');
  });

  it('files a session under the day the agent last spoke, not the sample time', () => {
    recordAgentSessionTelemetry(
      { worktreeId: 'wt-a', cliToolId: 'opencode' },
      telemetry({ at: new Date('2026-08-24T23:30:00').getTime() }),
    );
    sampleAgentSessionCosts(db, new Date('2026-08-25T00:05:00').getTime());
    expect(getAgentSessionCostsByDate(db, '2026-08-24')).toHaveLength(1);
    expect(getAgentSessionCostsByDate(db, DATE)).toHaveLength(0);
  });

  it('is idempotent: sampling twice leaves one row with one cost', () => {
    recordAgentSessionTelemetry({ worktreeId: 'wt-a', cliToolId: 'opencode' }, telemetry());
    sampleAgentSessionCosts(db, Date.now());
    sampleAgentSessionCosts(db, Date.now());
    const rows = getAgentSessionCostsByDate(db, DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBe(0.03754035);
  });

  it('skips a record the agent gave no session id for', () => {
    recordAgentSessionTelemetry({ worktreeId: 'wt-a', cliToolId: 'opencode' }, telemetry({ id: null }));
    expect(sampleAgentSessionCosts(db, Date.now())).toBe(0);
  });

  it('steps over a worktree that no longer exists instead of aborting the sweep', () => {
    seedWorktree('wt-live');
    recordAgentSessionTelemetry({ worktreeId: 'ghost', cliToolId: 'opencode' }, telemetry({ id: 'ses_ghost' }));
    recordAgentSessionTelemetry({ worktreeId: 'wt-live', cliToolId: 'opencode' }, telemetry({ id: 'ses_live' }));

    expect(sampleAgentSessionCosts(db, Date.now())).toBe(1);
    expect(getAgentSessionCostsByDate(db, DATE).map((r) => r.sessionId)).toEqual(['ses_live']);
  });

  it('does not start a timer under Vitest', () => {
    // A suite that opens a database must not acquire a background writer to it.
    expect(startAgentSessionCostSampler(db)).toBe(false);
  });
});

describe('localDateKey (Issue #2044)', () => {
  it('is the local calendar day, matching daily_reports.date', () => {
    const localMidnight = new Date('2026-08-25T00:00:00');
    expect(localDateKey(localMidnight.getTime())).toBe('2026-08-25');
    expect(localDateKey(new Date('2026-08-25T23:59:59').getTime())).toBe('2026-08-25');
  });

  it('zero-pads month and day', () => {
    expect(localDateKey(new Date('2026-01-02T12:00:00').getTime())).toBe('2026-01-02');
  });
});
