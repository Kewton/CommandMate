/**
 * Copy the live agent-session telemetry into the durable ledger (Issue #2044).
 *
 * ## What this is, and what it deliberately is not
 *
 * It is **not** a second reader of `session.updated`. #2040's record is the one
 * and only mapping of that frame, and adding another would give CommandMate two
 * opinions about one number — the failure #2040's own module comment is written
 * to prevent. This module reads that finished record, through its public getter,
 * and writes it to `agent_session_costs`.
 *
 * It is a **sampler** because the record it copies is cumulative-per-session
 * (measured; see migration v58) and dies when the pane is killed. Cumulative
 * means "any sample after the last update is sufficient and no sample is
 * double-counted"; dying means "a sample has to happen before the pane closes".
 * Together those give the design: look periodically, overwrite by session id,
 * and never add.
 *
 * ## Why the key enumeration reaches into `globalThis`
 *
 * `lib/hooks/agent-session-telemetry` exports a getter keyed by
 * `(worktreeId, cliToolId, instanceId)` and no iterator, and that module is
 * owned by a different Issue (#2041) for the duration of this work. The keys are
 * `buildCompositeKey()` output — `worktreeId:cliToolId[:instanceId]`, with the
 * separator forbidden inside either id by that function's own guards — so they
 * parse unambiguously. Only the *keys* are taken that way; every **value** comes
 * back through `getAgentSessionTelemetry()`, so the record's shape stays that
 * module's business. Adding an iterator there and deleting
 * {@link listTelemetryTargets} is the tidier end state and costs one export.
 *
 * @module lib/db/agent-session-cost-sampler
 */

import type Database from 'better-sqlite3';
import { getAgentSessionTelemetry } from '@/lib/hooks/agent-session-telemetry';
import { isCliToolType, type CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { recordAgentSessionCost } from './agent-session-cost-db';

const logger = createLogger('agent-session-cost-sampler');

/**
 * How often the background sampler looks.
 *
 * A minute is short next to how long a session lives and long next to how
 * cheaply a Map is walked; the value is not load-bearing for correctness, only
 * for how much of a session's tail is lost if the pane is killed between
 * samples. Cumulative numbers are what make that true — see the module comment.
 */
export const AGENT_SESSION_COST_SAMPLE_INTERVAL_MS = 60_000;

/** One instance whose telemetry can be read. */
export interface TelemetryTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
}

/**
 * The local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Local rather than UTC, and hand-formatted rather than `toISOString()`, because
 * this string is compared against `daily_reports.date`, which
 * `daily-summary-generator` builds from `new Date(date + 'T00:00:00')` — a local
 * midnight. Using UTC here would file the evening's sessions under tomorrow for
 * anyone east of Greenwich.
 */
export function localDateKey(at: number): string {
  const d = new Date(at);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Every instance the telemetry map currently holds a record for.
 *
 * Keys that do not parse — an unknown CLI tool id, a shape
 * `buildCompositeKey()` would not produce — are skipped rather than guessed at.
 * A malformed key means somebody wrote to the map by hand, and inventing a
 * worktree id for it would put a real cost against a worktree that never
 * incurred it.
 */
export function listTelemetryTargets(): TelemetryTarget[] {
  const records = globalThis.__agentSessionTelemetry;
  if (!records) return [];

  const targets: TelemetryTarget[] = [];
  for (const key of records.keys()) {
    const parts = key.split(':');
    if (parts.length < 2 || parts.length > 3) continue;
    const [worktreeId, cliToolId, instanceId] = parts;
    if (!worktreeId || !isCliToolType(cliToolId)) continue;
    targets.push({ worktreeId, cliToolId, instanceId: instanceId || undefined });
  }
  return targets;
}

/**
 * Copy every live telemetry record into the ledger.
 *
 * A record with no session id is skipped: the ledger is keyed by the agent's own
 * id, and a synthetic key would let one conversation appear twice under two
 * invented names, which is precisely the double-count last-write-wins exists to
 * avoid.
 *
 * Individual write failures are logged and stepped over rather than aborting the
 * sweep — the common one is the FK refusing a worktree that was deleted between
 * the map write and this call, which is not a reason to stop sampling the
 * others.
 *
 * @param db - Database instance
 * @param now - Epoch ms to stamp the samples with (injected for tests)
 * @returns How many rows were written
 */
export function sampleAgentSessionCosts(db: Database.Database, now: number = Date.now()): number {
  let written = 0;

  for (const target of listTelemetryTargets()) {
    const record = getAgentSessionTelemetry(target.worktreeId, target.cliToolId, target.instanceId);
    if (!record || !record.id) continue;

    try {
      const inserted = recordAgentSessionCost(db, {
        sessionId: record.id,
        worktreeId: target.worktreeId,
        cliToolId: target.cliToolId,
        instanceId: target.instanceId ?? null,
        // `record.at` is when the agent last spoke, which is the honest date for
        // the spend it reported; `now` only stamps the sample.
        date: localDateKey(record.at || now),
        title: record.title,
        agent: record.agent,
        model: record.model,
        provider: record.provider,
        cost: record.cost,
        tokensInput: record.tokens.input,
        tokensOutput: record.tokens.output,
        tokensReasoning: record.tokens.reasoning,
        tokensCacheRead: record.tokens.cacheRead,
        tokensCacheWrite: record.tokens.cacheWrite,
        observedAt: now,
      });
      if (inserted) written++;
    } catch (error) {
      logger.warn('sample-failed', {
        worktreeId: target.worktreeId,
        cliToolId: target.cliToolId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return written;
}

// =============================================================================
// Background sampler
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __agentSessionCostSampler: NodeJS.Timeout | undefined;
}

/**
 * Start the periodic sampler, once per process.
 *
 * Called from `getDbInstance()` — the one place in the server that runs exactly
 * once, after the schema is known good, and that every process holding a
 * database also holds. A `commandmate` CLI process reaches it too and samples an
 * empty map, which costs a `Map.keys()` per minute and keeps the wiring from
 * needing to know which kind of process it is in.
 *
 * The timer is `unref()`d so it never keeps Node alive, and skipped outright
 * under Vitest: a suite that opens a database should not acquire a background
 * writer to a file it is about to delete.
 *
 * @param db - Database instance to write into
 * @returns Whether a timer was started by this call
 */
export function startAgentSessionCostSampler(db: Database.Database): boolean {
  if (globalThis.__agentSessionCostSampler) return false;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;

  const timer = setInterval(() => {
    try {
      sampleAgentSessionCosts(db);
    } catch (error) {
      logger.warn('sweep-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, AGENT_SESSION_COST_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  globalThis.__agentSessionCostSampler = timer;
  return true;
}

/** Stop the periodic sampler. Test seam and shutdown hook. */
export function stopAgentSessionCostSampler(): void {
  if (!globalThis.__agentSessionCostSampler) return;
  clearInterval(globalThis.__agentSessionCostSampler);
  globalThis.__agentSessionCostSampler = undefined;
}
