/**
 * `GET /api/worktrees/:id/mem/brief` (Issue #4223, design §5.6・§6): read the query,
 * build, fit to the budget, answer. Neither reserves nor settles a notice: the CLI's
 * brief is a read (D1 §5.2 C8).
 *
 * A change of the membership while building is retried once from the start; a second
 * one answers `disabled` when the branch is `off` by then, else `ambiguous` (§5.4).
 *
 * Issue #4224 (D2 design §6.3): `sessionStart=1` is the form a `SessionStart` hook calls.
 * When the send path will put the brief in front of the conversation's first send (the
 * branch is `derived` / `on` with `injectOnStart`, and the instance's tool is one whose
 * boundaries are detected), it answers an empty text marked `deferred: 'send'` — so a hook
 * and the send never put two briefs in one conversation. Decided from the membership and
 * the tool alone: the ledger is neither read nor written, nothing is built or reserved.
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
  pinnedLifetimeChange,
  type BriefBuildDeps,
  type BriefChangeReason,
  type BuildBriefOutcome,
} from './build';
import { fitJson, fitText } from './fit';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { withMemTarget } from '@/lib/mem/target';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { BOUNDARY_TOOLS } from '@/lib/session/session-boundary';

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
  /** Issue #4224: `1` from `commandmate brief --session-start`. */
  sessionStart?: string | null;
}

/**
 * Whether the send path briefs this instance's next conversation (D2 design §6.3): the
 * membership's mode and `injectOnStart`, and the tool's boundaries. Null: it does not, and
 * the hook prints the brief as `commandmate brief` does.
 */
export async function sessionStartDeferredTo(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  deps: BriefBuildDeps = {}
): Promise<{ mode: 'derived' | 'on' } | null> {
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return null;
  const instance = resolveAgentInstances(db, worktreeId, worktree.selectedAgents).find((entry) => entry.id === instanceId);
  if (!instance || !BOUNDARY_TOOLS.has(instance.cliTool)) return null;
  return withMemTarget(db, { via: 'worktree', worktreeId }, deps.target ?? {}, (target) =>
    target.ok && target.mode !== 'off' && target.features.injectOnStart ? { mode: target.mode } : null
  );
}

/** What the request named is gone: answered as such, never built for its successor. */
function lifetimeChanged(why: BriefChangeReason): MemOutcome {
  return why === 'worktree_lifetime'
    ? memError('not_found', { reason: 'lifetime_changed' })
    : memError('instance_not_found', { reason: 'lifetime_changed' });
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
  const sessionStart = query.sessionStart === '1';
  if (query.sessionStart !== undefined && query.sessionStart !== null && !sessionStart) {
    return memError('invalid_request', { field: 'sessionStart' });
  }
  if (sessionStart && format !== 'text') return memError('invalid_request', { field: 'format' });
  let maxBytes: number | null = all ? null : BRIEF_BUDGET[format].default;
  if (query.budget !== null) {
    const parsed = parseBriefBudget(query.budget, format);
    if (!parsed.ok) return memError('invalid_request', { field: 'budget', reason: parsed.reason });
    maxBytes = parsed.maxBytes;
  }

  // The request's lifetimes, fixed once before the first await: the session-start pre-check
  // and every build of this request are for them (Issue #4224, Codex 5-2b P1 — the pin was
  // after the pre-check's await, so a worktree made again meanwhile was the one pinned).
  const pinned = pinBriefLifetime(db, worktreeId, instanceId);

  if (sessionStart && pinned) {
    const deferred = await sessionStartDeferredTo(db, worktreeId, instanceId, deps);
    const changed = pinnedLifetimeChange(db, worktreeId, instanceId, pinned);
    if (changed) {
      logger.info('brief-membership-changed', { worktreeId, instanceId, attempt: 0, why: changed });
      return lifetimeChanged(changed);
    }
    if (deferred) {
      const body: BriefTextResponse = { ok: true, format: 'text', mode: deferred.mode, text: '', omitted: 0, deferred: 'send' };
      return { status: 200, body };
    }
  }

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
        return lifetimeChanged(error.why);
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
