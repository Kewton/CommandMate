/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 *
 * Issue #2060 splits the response into the two halves it has always computed
 * together — the DB rows (the "list") and the tmux-derived session status — and
 * gives the caller a way to ask for the first without paying for the second
 * (`?includeStatus=0`). It also makes the split measurable: every request emits
 * one structured record with the two timings side by side and the counters that
 * explain them.
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering - this route uses searchParams and database access
export const dynamic = 'force-dynamic';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktrees, getRepositories, getMessages, markPendingPromptsAsAnswered, getAgentInstances } from '@/lib/db';
import { listSessions } from '@/lib/tmux/tmux';
import {
  createStatusDetectionMetrics,
  detectWorktreeSessionStatus,
  type WorktreeSessionStatus,
} from '@/lib/session/worktree-status-helper';
import { parseIncludeParam, parseIncludeStatusParam } from '@/lib/api/worktrees-include-parser';
import { isWorktreeStalled } from '@/lib/detection/stalled-detector';
import { getNextAction, getReviewStatus } from '@/lib/session/next-action-helper';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { deriveSessionStatus } from '@/lib/session/status-mapping';
import { createLogger } from '@/lib/logger';
import type { PromptType } from '@/types/models';

const logger = createLogger('api/worktrees');

/**
 * Above this, one list request is also logged at `warn` (Issue #2060).
 *
 * The per-request record itself is `debug`: the sidebar polls this route every
 * few seconds, so an unconditional `info` line would be the noisiest thing in
 * the log for a number that is uninteresting when it is normal. `warn` is
 * reserved for the case an operator actually wants to find after the fact —
 * a poll that took longer than the poll interval.
 */
const SLOW_LIST_THRESHOLD_MS = 1000;

/** Milliseconds at 0.1ms resolution; full float precision is noise in a log. */
function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  try {
    const db = getDbInstance();

    // Check for query parameters
    const searchParams = request.nextUrl?.searchParams;
    const repositoryFilter = searchParams?.get('repository');
    const includes = parseIncludeParam(searchParams?.get('include') ?? null);
    const includeReview = includes.has('review');
    // Issue #2060: additive opt-OUT. Absent means "status included", which is
    // what every caller written before this parameter existed asks for.
    const includeStatus = parseIncludeStatusParam(searchParams?.get('includeStatus') ?? null);

    // ---- Phase 1: the list. Local SQLite only, no tmux. -------------------
    const dbStartedAt = performance.now();
    const worktrees = getWorktrees(db, repositoryFilter || undefined);
    // Get repository list
    const repositories = getRepositories(db);
    // Issue #878: include the agent-instance roster so the sidebar can
    // aggregate per-instance status (matches the single worktree API).
    // Resolved here rather than inside the status loop so that the two phases
    // below are timed for what they actually are: this is a DB read and belongs
    // to the list, not to the tmux pass.
    const agentInstancesByWorktree = new Map(
      worktrees.map((worktree) => [
        worktree.id,
        resolveAgentInstances(db, worktree.id, worktree.selectedAgents),
      ])
    );
    const dbMs = performance.now() - dbStartedAt;

    // ---- Phase 2: the status. Every tmux round-trip lives here. -----------
    const metrics = createStatusDetectionMetrics();
    const statusByWorktree = new Map<string, WorktreeSessionStatus>();
    let tmuxSessionCount = 0;
    let statusMs = 0;
    // Split one level finer than the Issue asks for, because the two halves have
    // different fixes: `listSessions()` is ONE `tmux list-sessions` whose cost is
    // independent of how many worktrees exist, while the probe fan-out below is
    // the part that scales — and it scales with running sessions, not rows.
    let listSessionsMs = 0;
    let probeMs = 0;

    if (includeStatus) {
      const statusStartedAt = performance.now();
      // Issue #405: Batch query all tmux sessions once (N+1 elimination)
      const tmuxSessions = await listSessions();
      listSessionsMs = performance.now() - statusStartedAt;
      tmuxSessionCount = tmuxSessions.length;
      const sessionNameSet = new Set(tmuxSessions.map(s => s.name));

      const probeStartedAt = performance.now();
      await Promise.all(
        worktrees.map(async (worktree) => {
          const status = await detectWorktreeSessionStatus(
            worktree.id,
            sessionNameSet,
            db,
            getMessages,
            markPendingPromptsAsAnswered,
            getAgentInstances,
            metrics,
          );
          statusByWorktree.set(worktree.id, status);
        })
      );
      probeMs = performance.now() - probeStartedAt;
      statusMs = performance.now() - statusStartedAt;
    }

    // ---- Phase 3: compose. -------------------------------------------------
    const worktreesWithStatus = worktrees.map((worktree) => {
      const agentInstances = agentInstancesByWorktree.get(worktree.id) ?? [];
      const status = statusByWorktree.get(worktree.id);

      // `?includeStatus=0`: the status keys are OMITTED rather than zeroed. All
      // of them are optional on `Worktree`, and absence is the only honest way
      // to say "not measured" — a row of `false`s is indistinguishable from a
      // worktree with nothing running, and would render as a confident `idle`
      // dot. The review block goes with it: `nextAction` / `reviewStatus` are
      // derived from the status, so there is nothing to derive them from.
      if (!status) {
        return { ...worktree, agentInstances };
      }

      const base = {
        ...worktree,
        ...status,
        agentInstances,
      };

      // Issue #600: Add review fields when ?include=review
      if (includeReview) {
        const cliToolId = worktree.cliToolId ?? 'claude';
        const sessionStatus = deriveSessionStatus(status);
        const stalled = isWorktreeStalled(worktree.id, cliToolId);
        // Derive promptType from status helper - approximate from isWaitingForResponse
        const promptType: PromptType | null = status.isWaitingForResponse ? 'approval' : null;
        const nextAction = getNextAction(sessionStatus, promptType, stalled);
        const reviewStatus = getReviewStatus(
          worktree.status ?? null,
          sessionStatus,
          promptType,
          stalled
        );

        return {
          ...base,
          isStalled: stalled,
          nextAction,
          reviewStatus,
        };
      }

      return base;
    });

    const totalMs = performance.now() - startedAt;
    // Issue #2060: ONE record, with the breakdown in it. `captureCount` beside
    // `tmuxSessionCount` is the whole point — captures scale with RUNNING
    // sessions, not with `worktreeCount`, and only the pair shows that.
    const timing = {
      totalMs: roundMs(totalMs),
      dbMs: roundMs(dbMs),
      statusMs: roundMs(statusMs),
      listSessionsMs: roundMs(listSessionsMs),
      probeMs: roundMs(probeMs),
      worktreeCount: worktrees.length,
      repositoryCount: repositories.length,
      tmuxSessionCount,
      probeCount: metrics.probeCount,
      captureCount: metrics.captureCount,
      healthCheckCount: metrics.healthCheckCount,
      includeStatus,
      includeReview,
    };
    logger.debug('list:timing', timing);
    if (totalMs >= SLOW_LIST_THRESHOLD_MS) {
      logger.warn('list:slow', timing);
    }

    return NextResponse.json(
      {
        worktrees: worktreesWithStatus,
        repositories,
        // Only present when the caller opted out, so the default response shape
        // is byte-for-byte what it was before #2060.
        ...(includeStatus ? {} : { statusIncluded: false }),
      },
      { status: 200 }
    );
  } catch (error) {
    logger.error('error-fetching-worktrees:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to fetch worktrees' },
      { status: 500 }
    );
  }
}
