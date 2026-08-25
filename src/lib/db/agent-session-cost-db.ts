/**
 * Agent session cost ledger (Issue #2044)
 *
 * CRUD for `agent_session_costs` — the durable half of what
 * `lib/hooks/agent-session-telemetry` keeps in memory. See migration v58 for
 * why the table exists, why `session_id` is the key and why writes overwrite
 * rather than accumulate.
 *
 * Everything here is a pure function of `(db, args)`; the thing that decides
 * *when* to write lives in `./agent-session-cost-sampler`.
 */

import type Database from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

/**
 * One session's spend, as the agent reports it.
 *
 * Every numeric field is `number | null`, and null means "the agent did not
 * say" — never zero. The distinction survives all the way to the report, where
 * a missing count prints `-` and a real zero prints `0`.
 */
export interface AgentSessionCostRecord {
  /** The agent's own session id (opencode's `ses_…`). Primary key. */
  sessionId: string;
  worktreeId: string;
  cliToolId: string;
  /** Agent instance id, or null for the worktree's primary instance. */
  instanceId: string | null;
  /** Local calendar day, `YYYY-MM-DD`, matching `daily_reports.date`. */
  date: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  provider: string | null;
  cost: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  /** Epoch ms this session was first written. */
  firstSeenAt: number;
  /** Epoch ms of the most recent sample. */
  observedAt: number;
}

/** What one worktree spent on one day. */
export interface WorktreeDailyCost {
  worktreeId: string;
  /** Distinct sessions that contributed. */
  sessions: number;
  /**
   * Summed session cost, or null when no contributing session reported one.
   *
   * SQLite's `SUM()` already answers NULL for an all-NULL group and skips NULLs
   * in a mixed one, which is the arithmetic this column wants: a session that
   * never reported a cost must not be counted as free.
   */
  cost: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
}

/** A day's ledger, per worktree and in total. */
export interface DailyAgentCostSummary {
  date: string;
  /** Per-worktree rows, most expensive first. */
  worktrees: WorktreeDailyCost[];
  /** The same columns summed across every worktree. */
  total: Omit<WorktreeDailyCost, 'worktreeId'>;
}

interface AgentSessionCostRow {
  session_id: string;
  worktree_id: string;
  cli_tool_id: string;
  instance_id: string | null;
  date: string;
  title: string | null;
  agent: string | null;
  model: string | null;
  provider: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  first_seen_at: number;
  observed_at: number;
}

// =============================================================================
// Row Mapping
// =============================================================================

function mapRow(row: AgentSessionCostRow): AgentSessionCostRecord {
  return {
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id,
    instanceId: row.instance_id,
    date: row.date,
    title: row.title,
    agent: row.agent,
    model: row.model,
    provider: row.provider,
    cost: row.cost,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensReasoning: row.tokens_reasoning,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write,
    firstSeenAt: row.first_seen_at,
    observedAt: row.observed_at,
  };
}

const COST_COLUMNS =
  'session_id, worktree_id, cli_tool_id, instance_id, date, title, agent, model, provider, ' +
  'cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, ' +
  'first_seen_at, observed_at';

// =============================================================================
// Write
// =============================================================================

/** What {@link recordAgentSessionCost} needs; timestamps are supplied by the caller. */
export type AgentSessionCostInput = Omit<AgentSessionCostRecord, 'firstSeenAt' | 'observedAt'> & {
  /** Epoch ms of this sample. */
  observedAt: number;
};

/**
 * Insert or refresh one session's ledger row.
 *
 * `ON CONFLICT(session_id)` updates the spend columns and `observed_at`, and
 * leaves `date` and `first_seen_at` alone. That asymmetry is the whole point:
 * the numbers are cumulative and must be *replaced* (see migration v58), while
 * the day the session opened must not move when a long conversation is sampled
 * again after midnight.
 *
 * `worktree_id` is refreshed too, because an instance can be re-registered
 * against a renamed worktree id between samples and the ledger should follow
 * the live one rather than keep a dead reference.
 *
 * @param db - Database instance
 * @param input - The sample
 * @returns Whether a row was inserted or updated (false when the write was a
 *   no-op because the worktree row is gone — the FK refuses it)
 */
export function recordAgentSessionCost(
  db: Database.Database,
  input: AgentSessionCostInput
): boolean {
  const stmt = db.prepare(`
    INSERT INTO agent_session_costs (
      session_id, worktree_id, cli_tool_id, instance_id, date, title, agent, model, provider,
      cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      first_seen_at, observed_at
    ) VALUES (
      @sessionId, @worktreeId, @cliToolId, @instanceId, @date, @title, @agent, @model, @provider,
      @cost, @tokensInput, @tokensOutput, @tokensReasoning, @tokensCacheRead, @tokensCacheWrite,
      @observedAt, @observedAt
    )
    ON CONFLICT(session_id) DO UPDATE SET
      worktree_id = excluded.worktree_id,
      cli_tool_id = excluded.cli_tool_id,
      instance_id = excluded.instance_id,
      title = excluded.title,
      agent = excluded.agent,
      model = excluded.model,
      provider = excluded.provider,
      cost = excluded.cost,
      tokens_input = excluded.tokens_input,
      tokens_output = excluded.tokens_output,
      tokens_reasoning = excluded.tokens_reasoning,
      tokens_cache_read = excluded.tokens_cache_read,
      tokens_cache_write = excluded.tokens_cache_write,
      observed_at = excluded.observed_at
  `);

  const result = stmt.run({
    sessionId: input.sessionId,
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId,
    date: input.date,
    title: input.title,
    agent: input.agent,
    model: input.model,
    provider: input.provider,
    cost: input.cost,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    tokensReasoning: input.tokensReasoning,
    tokensCacheRead: input.tokensCacheRead,
    tokensCacheWrite: input.tokensCacheWrite,
    observedAt: input.observedAt,
  });

  return result.changes > 0;
}

// =============================================================================
// Read
// =============================================================================

/**
 * Every session recorded for a day, newest sample first.
 *
 * @param db - Database instance
 * @param date - `YYYY-MM-DD`
 */
export function getAgentSessionCostsByDate(
  db: Database.Database,
  date: string
): AgentSessionCostRecord[] {
  const rows = db
    .prepare(
      `SELECT ${COST_COLUMNS} FROM agent_session_costs WHERE date = ? ORDER BY observed_at DESC, session_id`
    )
    .all(date) as AgentSessionCostRow[];
  return rows.map(mapRow);
}

/**
 * A day's spend, per worktree and in total.
 *
 * The per-worktree rows are what `opencode stats --project <path>` reports for
 * that project, and the total is what `opencode stats` reports across all of
 * them — provided the ledger saw every session, which is the sampler's job and
 * not this query's. Sorted by cost descending with NULLs last, so "which
 * worktree is expensive" is the first line rather than a scan.
 *
 * @param db - Database instance
 * @param date - `YYYY-MM-DD`
 * @param cliToolId - Optional filter; omit for every tool that reported
 */
export function getDailyAgentCostSummary(
  db: Database.Database,
  date: string,
  cliToolId?: string
): DailyAgentCostSummary {
  const where = cliToolId ? 'WHERE date = ? AND cli_tool_id = ?' : 'WHERE date = ?';
  const params = cliToolId ? [date, cliToolId] : [date];

  const rows = db
    .prepare(
      `SELECT
         worktree_id,
         COUNT(*) AS sessions,
         SUM(cost) AS cost,
         SUM(tokens_input) AS tokens_input,
         SUM(tokens_output) AS tokens_output,
         SUM(tokens_reasoning) AS tokens_reasoning,
         SUM(tokens_cache_read) AS tokens_cache_read,
         SUM(tokens_cache_write) AS tokens_cache_write
       FROM agent_session_costs
       ${where}
       GROUP BY worktree_id
       ORDER BY cost IS NULL, cost DESC, worktree_id`
    )
    .all(...params) as Array<{
      worktree_id: string;
      sessions: number;
      cost: number | null;
      tokens_input: number | null;
      tokens_output: number | null;
      tokens_reasoning: number | null;
      tokens_cache_read: number | null;
      tokens_cache_write: number | null;
    }>;

  const worktrees: WorktreeDailyCost[] = rows.map((row) => ({
    worktreeId: row.worktree_id,
    sessions: row.sessions,
    cost: row.cost,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    tokensReasoning: row.tokens_reasoning,
    tokensCacheRead: row.tokens_cache_read,
    tokensCacheWrite: row.tokens_cache_write,
  }));

  return { date, worktrees, total: sumWorktreeCosts(worktrees) };
}

/**
 * Add the per-worktree rows up, preserving "nobody said" as null.
 *
 * Done in TypeScript rather than a second `SUM()` query so the total is
 * arithmetically the same numbers the caller is about to print — a rollup query
 * could disagree with the rows above it if the two ever drifted on filtering,
 * and a report whose total does not match its own lines is worse than no total.
 */
function sumWorktreeCosts(worktrees: WorktreeDailyCost[]): Omit<WorktreeDailyCost, 'worktreeId'> {
  const add = (pick: (row: WorktreeDailyCost) => number | null): number | null => {
    let sum: number | null = null;
    for (const row of worktrees) {
      const value = pick(row);
      if (value === null) continue;
      sum = (sum ?? 0) + value;
    }
    return sum;
  };

  return {
    sessions: worktrees.reduce((acc, row) => acc + row.sessions, 0),
    cost: add((row) => row.cost),
    tokensInput: add((row) => row.tokensInput),
    tokensOutput: add((row) => row.tokensOutput),
    tokensReasoning: add((row) => row.tokensReasoning),
    tokensCacheRead: add((row) => row.tokensCacheRead),
    tokensCacheWrite: add((row) => row.tokensCacheWrite),
  };
}

/**
 * Delete the ledger rows for a day. Test seam and manual-reset affordance.
 *
 * @returns Number of rows removed
 */
export function deleteAgentSessionCostsByDate(db: Database.Database, date: string): number {
  return db.prepare('DELETE FROM agent_session_costs WHERE date = ?').run(date).changes;
}
