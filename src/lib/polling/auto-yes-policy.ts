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
 * Issue #3822: a failed lookup is not cached. It is "contract unknown", which
 * the answering paths read as withholding, and holding it for the TTL would
 * keep withholding after the database recovered; the next poll reads again.
 *
 * @module lib/polling/auto-yes-policy
 */

import { getActiveTaskForInstance } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  AUTO_YES_POLICY_UNKNOWN,
  isAutoYesPolicyUnknown,
  type AutoYesPolicy,
  type AutoYesPolicyLookup,
} from './auto-yes-resolver';

const logger = createLogger('auto-yes-policy');

/** How long a resolved policy is reused before the task is looked up again. */
export const AUTO_YES_POLICY_CACHE_TTL_MS = 5000;

/**
 * Cache ceiling. Above it, expired entries are dropped on write, so a long-lived
 * server cannot accumulate one entry per worktree ever polled.
 */
const MAX_CACHE_ENTRIES = 200;

interface PolicyCacheEntry {
  /** {@link AUTO_YES_POLICY_UNKNOWN} only for a failed lookup, which is never cached. */
  policy: AutoYesPolicyLookup;
  /** The active task the policy came from; null with no contract. */
  taskId: string | null;
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
 * Issue #3822: a database failure yields {@link AUTO_YES_POLICY_UNKNOWN}, not
 * null. It used to yield null — the unconstrained behaviour — so a contract
 * stating `off` or a deny pattern was answered past whenever one read failed.
 * Users without a contract are still untouched: a lookup that succeeds and
 * finds no task is null, as before, and only a lookup that fails withholds.
 */
function readPolicy(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string
): { policy: AutoYesPolicyLookup; taskId: string | null } {
  try {
    const task = getActiveTaskForInstance(getDbInstance(), worktreeId, cliToolId, instanceId);
    if (!task) return { policy: null, taskId: null };
    // Assignment, not a cast: a drift in TaskContractAutoYes fails the build here.
    const policy: AutoYesPolicy = task.contract.autoYes;
    return { policy, taskId: task.id };
  } catch (error) {
    logger.warn('policy-lookup-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { policy: AUTO_YES_POLICY_UNKNOWN, taskId: null };
  }
}

/**
 * The auto-answer policy for an agent instance, cached for
 * {@link AUTO_YES_POLICY_CACHE_TTL_MS}.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool being polled
 * For the paths that answer (the poller and the `PermissionRequest` hook):
 * the resolver reads {@link AUTO_YES_POLICY_UNKNOWN} as withholding (Issue #3822).
 *
 * @param instanceId - Agent instance id (defaults to the primary, i.e. cliToolId)
 * @param options - `fresh: true` reads the task past the cache (and refreshes
 *   it): the poller's last look before a key (Issue #3822), where a contract
 *   switched or a deny pattern added within the TTL must already count
 * @returns The contract's autoYes block, null when no contract governs this
 *   instance, or {@link AUTO_YES_POLICY_UNKNOWN} when the lookup failed
 */
export function getSessionAutoYesPolicy(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  options?: { fresh?: boolean }
): AutoYesPolicyLookup {
  return lookupEntry(worktreeId, cliToolId, instanceId, options?.fresh === true).policy;
}

/**
 * The policy and the id of the task it came from, read in ONE lookup (Issue
 * #3724), so a log line naming both cannot pair one task's verdict with another
 * task's id when the cache expires between two reads. `taskId` is null when no
 * contract governs the instance.
 *
 * For display only (Issue #3822): a failed lookup reads as no contract here
 * (`policy` and `taskId` null), never as a contract this lookup did not see.
 */
export function getSessionAutoYesPolicyEntry(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): { policy: AutoYesPolicy | null; taskId: string | null } {
  const { policy, taskId } = lookupEntry(worktreeId, cliToolId, instanceId);
  if (isAutoYesPolicyUnknown(policy)) return { policy: null, taskId: null };
  return { policy, taskId };
}

/**
 * {@link getSessionAutoYesPolicyEntry} for a path that judges the prompt again
 * (Issue #3822): a failed lookup stays {@link AUTO_YES_POLICY_UNKNOWN} instead of
 * reading as no contract, so the resolver withholds on it as the tick did.
 * `taskId` is null when no contract governs the instance or the lookup failed.
 */
export function getSessionAutoYesPolicyLookupEntry(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): { policy: AutoYesPolicyLookup; taskId: string | null } {
  const { policy, taskId } = lookupEntry(worktreeId, cliToolId, instanceId);
  return { policy, taskId };
}

/**
 * Whether the contract's policy keeps Auto-Yes from ever answering (Issue #3723).
 *
 * `mode: 'off'` only. `safe` / `allow-listed` still answer some prompts, and a
 * null mode (or no contract) states nothing, so those are not blocked. The
 * poller's resolver reaches the same verdict from the same policy.
 */
export function isAutoYesBlockedByPolicy(policy: AutoYesPolicy | null): boolean {
  return policy?.mode === 'off';
}

/**
 * Whether the contract governing this instance keeps Auto-Yes from answering
 * (Issue #3723). The poller's own lookup ({@link getSessionAutoYesPolicyEntry})
 * judged by {@link isAutoYesBlockedByPolicy}, so the list cannot read `blocked`
 * for an instance the poller would answer, or the reverse.
 */
export function isSessionAutoYesBlockedByContract(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): boolean {
  return isAutoYesBlockedByPolicy(getSessionAutoYesPolicyEntry(worktreeId, cliToolId, instanceId).policy);
}

/** What the contract says about Auto-Yes, as the API carries it (Issue #3723). */
export interface ContractPolicySummary {
  taskId: string | null;
  mode: AutoYesPolicy['mode'];
  allowPromptTypes: AutoYesPolicy['allowPromptTypes'];
  denyPatternCount: number;
}

/**
 * The contract policy of an agent instance in the shape the API returns, or null
 * when no contract governs it. Policy and task id come from ONE
 * {@link getSessionAutoYesPolicyEntry} lookup — the poller's cache — so the mode
 * and the task it names are the same task's.
 */
export function getSessionContractPolicySummary(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): ContractPolicySummary | null {
  const { policy, taskId } = getSessionAutoYesPolicyEntry(worktreeId, cliToolId, instanceId);
  if (!policy) return null;
  return {
    taskId,
    mode: policy.mode,
    allowPromptTypes: policy.allowPromptTypes,
    denyPatternCount: policy.denyPatterns.length,
  };
}

function lookupEntry(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  fresh = false
): PolicyCacheEntry {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const key = buildCompositeKey(worktreeId, cliToolId, resolvedInstanceId);
  const now = Date.now();

  const cached = policyCache.get(key);
  if (!fresh && cached && cached.expiresAt > now) {
    return cached;
  }

  const { policy, taskId } = readPolicy(worktreeId, cliToolId, resolvedInstanceId);
  if (isAutoYesPolicyUnknown(policy)) {
    // Issue #3822: not cached, so the next lookup reads again. A fresh read
    // that failed also drops what was cached: it is no longer known to hold.
    if (fresh) policyCache.delete(key);
    return { policy, taskId, expiresAt: now };
  }

  if (policyCache.size >= MAX_CACHE_ENTRIES) {
    purgeExpired(now);
  }
  const entry: PolicyCacheEntry = { policy, taskId, expiresAt: now + AUTO_YES_POLICY_CACHE_TTL_MS };
  policyCache.set(key, entry);

  return entry;
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
