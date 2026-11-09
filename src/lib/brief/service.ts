/**
 * `GET /api/worktrees/:id/mem/brief` (Issue #4223, design §5.6・§6): read the query,
 * build, fit to the budget, answer. Neither reserves nor settles a notice: the CLI's
 * brief is a read (D1 §5.2 C8).
 *
 * A change of the membership while building is retried once from the start; a second
 * one answers `disabled` when the branch is `off` by then, else `ambiguous` (§5.4).
 *
 * @module lib/brief/service
 */

import type Database from 'better-sqlite3';
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_ID_LENGTH } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { memError, type MemOutcome } from '@/lib/mem/service';
import { BRIEF_BUDGET, BRIEF_FIXED_LIMITS, parseBriefBudget, type BriefFormat, type BriefTextResponse } from '@/types/brief';
import {
  BriefMembershipChangedError,
  buildBrief,
  CLI_TIME_BUDGET,
  pinBriefLifetime,
  type BriefBuildDeps,
  type BriefChangeReason,
  type BuildBriefOutcome,
} from './build';
import { fitJson, fitText } from './fit';

const logger = createLogger('brief');

const WORKTREE_ID = /^[A-Za-z0-9_-]+$/;

/** How many times the route builds one request (design §5.4: one rebuild). */
export const BRIEF_ROUTE_ATTEMPTS = 2;

/**
 * Which change the route rebuilds for (review P1, 2026-11-09). A changed membership or
 * mode is the same request asked again; a worktree or instance that ended is not — the
 * request was for the one that is gone, and a rebuild would land it on its successor.
 */
export const BRIEF_ROUTE_RETRIES: Readonly<Record<BriefChangeReason, boolean>> = {
  membership: true,
  mode: true,
  worktree_lifetime: false,
  instance_lifetime: false,
};

export interface BriefQuery {
  instance: string | null;
  budget: string | null;
  format: string | null;
  all: string | null;
}

export async function briefForRoute(
  db: Database.Database,
  worktreeId: string,
  query: BriefQuery,
  deps: BriefBuildDeps = {}
): Promise<MemOutcome> {
  if (!WORKTREE_ID.test(worktreeId) || worktreeId.length > BRIEF_FIXED_LIMITS.worktreeIdChars) {
    return memError('invalid_request', { field: 'worktree' });
  }
  const instanceId = query.instance;
  if (!instanceId) return memError('target_required', { field: 'instance' });
  if (!INSTANCE_ID_PATTERN.test(instanceId) || instanceId.length > MAX_INSTANCE_ID_LENGTH) {
    return memError('invalid_request', { field: 'instance' });
  }
  const format: BriefFormat | null = query.format === null || query.format === 'text' ? 'text' : query.format === 'json' ? 'json' : null;
  if (format === null) return memError('invalid_request', { field: 'format' });
  const all = query.all === '1';
  if (query.all !== null && query.all !== '1') return memError('invalid_request', { field: 'all' });
  if (all && query.budget !== null) return memError('invalid_request', { field: 'budget' });
  let maxBytes: number | null = all ? null : BRIEF_BUDGET[format].default;
  if (query.budget !== null) {
    const parsed = parseBriefBudget(query.budget, format);
    if (!parsed.ok) return memError('invalid_request', { field: 'budget', reason: parsed.reason });
    maxBytes = parsed.maxBytes;
  }

  // The request's lifetimes, fixed once: every build of this request is for them.
  const pinned = pinBriefLifetime(db, worktreeId, instanceId);
  let outcome: BuildBriefOutcome | null = null;
  for (let attempt = 1; attempt <= BRIEF_ROUTE_ATTEMPTS && outcome === null; attempt += 1) {
    try {
      outcome = await buildBrief(
        db,
        { worktreeId, instanceId, time: CLI_TIME_BUDGET, onMembershipTimeout: 'ambiguous', ...(pinned ? { pinned } : {}) },
        deps
      );
    } catch (error) {
      if (!(error instanceof BriefMembershipChangedError)) throw error;
      logger.info('brief-membership-changed', { worktreeId, instanceId, attempt, why: error.why });
      if (!BRIEF_ROUTE_RETRIES[error.why]) {
        // What the request named is gone: answered as such, never built again for its successor.
        return error.why === 'worktree_lifetime'
          ? memError('not_found', { reason: 'lifetime_changed' })
          : memError('instance_not_found', { reason: 'lifetime_changed' });
      }
      if (attempt === BRIEF_ROUTE_ATTEMPTS) {
        return error.modeNow === 'off' ? memError('disabled', { mode: 'off' }) : memError('ambiguous', { reason: 'registration_changed' });
      }
    }
  }
  if (!outcome || outcome.kind === 'empty') return memError('internal_error');
  if (outcome.kind === 'refused') {
    return memError(outcome.code, { ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.mode ? { mode: outcome.mode } : {}) });
  }
  if (format === 'json') {
    return { status: 200, body: fitJson(outcome.model, maxBytes).json };
  }
  const fitted = fitText(outcome.model, { maxBytes, trailingNewline: true });
  const body: BriefTextResponse = { ok: true, format: 'text', mode: outcome.model.fixed.mode, text: fitted.text, omitted: fitted.omitted };
  return { status: 200, body };
}
