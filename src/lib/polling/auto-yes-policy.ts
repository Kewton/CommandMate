/**
 * Auto-Yes policy lookup — resolves the `autoYes` block of the execution
 * contract governing one agent instance (Issue #1547).
 *
 * Server-only: reads the database. Kept out of auto-yes-state.ts so that module
 * stays free of a database dependency, and out of auto-yes-resolver.ts because
 * that one is bundled into the client.
 *
 * The result is cached per composite key with a short TTL. Without it, a prompt
 * the policy suppresses would be re-read from SQLite on every poll for as long
 * as it stays on screen: the poller's duplicate guard only remembers prompts it
 * *answered*, so a suppressed prompt is re-evaluated every POLLING_INTERVAL_MS
 * indefinitely. The TTL is what bounds staleness — a task that starts or ends is
 * picked up within it, without this module having to observe task transitions.
 *
 * @module lib/polling/auto-yes-policy
 */

import { getActiveTaskForInstance } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { AutoYesPolicy } from './auto-yes-resolver';

const logger = createLogger('auto-yes-policy');

/** How long a resolved policy is reused before the task is looked up again. */
export const AUTO_YES_POLICY_CACHE_TTL_MS = 5000;

/**
 * Cache ceiling. Above it, expired entries are dropped on write, so a long-lived
 * server cannot accumulate one entry per worktree ever polled.
 */
const MAX_CACHE_ENTRIES = 200;

interface PolicyCacheEntry {
  policy: AutoYesPolicy | null;
  expiresAt: number;
}

/**
 * Plain module-level Map rather than the globalThis pattern used for auto-yes
 * *state*: losing a cache on hot reload costs one database read, while losing
 * state would silently disable auto-yes.
 */
const policyCache = new Map<string, PolicyCacheEntry>();

function purgeExpired(now: number): void {
  for (const [key, entry] of policyCache.entries()) {
    if (entry.expiresAt <= now) {
      policyCache.delete(key);
    }
  }
}

/**
 * Read the policy from the active task, or null when no contract governs this
 * instance.
 *
 * A database failure yields null — the unconstrained behaviour. Failing closed
 * here would suppress auto-yes for every user who has no contract at all, which
 * is the population this feature must not touch; the suppressing decisions
 * (`off`, deny patterns) are made inside the resolver only once a contract has
 * actually been read.
 */
function readPolicy(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string
): AutoYesPolicy | null {
  try {
    const task = getActiveTaskForInstance(getDbInstance(), worktreeId, cliToolId, instanceId);
    if (!task) return null;
    // Assignment, not a cast: a drift in TaskContractAutoYes fails the build here.
    const policy: AutoYesPolicy = task.contract.autoYes;
    return policy;
  } catch (error) {
    logger.warn('policy-lookup-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The auto-answer policy for an agent instance, cached for
 * {@link AUTO_YES_POLICY_CACHE_TTL_MS}.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool being polled
 * @param instanceId - Agent instance id (defaults to the primary, i.e. cliToolId)
 * @returns The contract's autoYes block, or null when no contract governs this instance
 */
export function getSessionAutoYesPolicy(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AutoYesPolicy | null {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const key = buildCompositeKey(worktreeId, cliToolId, resolvedInstanceId);
  const now = Date.now();

  const cached = policyCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.policy;
  }

  const policy = readPolicy(worktreeId, cliToolId, resolvedInstanceId);

  if (policyCache.size >= MAX_CACHE_ENTRIES) {
    purgeExpired(now);
  }
  policyCache.set(key, { policy, expiresAt: now + AUTO_YES_POLICY_CACHE_TTL_MS });

  return policy;
}

/**
 * Drop the cached policy for a composite key, so the next lookup re-reads the
 * task. Called when a poller starts or stops.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId[:instanceId])
 */
export function invalidateSessionAutoYesPolicy(compositeKey: string): void {
  policyCache.delete(compositeKey);
}

/**
 * Clear the whole cache.
 * @internal Exported for testing and worktree teardown.
 */
export function clearAutoYesPolicyCache(): void {
  policyCache.clear();
}
