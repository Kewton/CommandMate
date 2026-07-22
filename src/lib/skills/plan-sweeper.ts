/**
 * Background reclamation of expired Skill plans and snapshots (Issue #1429)
 *
 * A plan pins its verified artifact snapshot with a reference the snapshot store
 * will never evict, no matter how much quota pressure there is. That is correct
 * while the plan is live and wrong once it has expired, and until this module
 * existed the only thing that noticed the difference was the creation of the
 * *next* plan. A user who built a plan and never applied it therefore pinned up
 * to one artifact per abandoned plan for the life of the process.
 *
 * So expiry is made to happen on the clock rather than on traffic. The sweeper
 * drops expired plans first and expired snapshots second: the plan is what holds
 * the reference, so sweeping the other way round would always be one round late.
 *
 * Started lazily by the Skill routes rather than at boot, because a deployment
 * that never touches Skills should not carry a timer for them. The interval is
 * `unref`'d, so it never keeps the process alive.
 *
 * @module lib/skills/plan-sweeper
 */

import { SKILL_PLAN_SWEEP_INTERVAL_MS } from '@/config/skill-security-config';
import { createLogger } from '@/lib/logger';
import { sweepSkillInstallPlans } from '@/lib/skills/install-plan';
import { sweepSkillUninstallPlans } from '@/lib/skills/uninstall-plan';
import { isSkillSnapshotStoreInitialized, sweepSkillSnapshots } from '@/lib/skills/snapshot-store';

const logger = createLogger('lib/skills/plan-sweeper');

/** What one sweep reclaimed. */
export interface SkillPlanSweepResult {
  installPlans: number;
  uninstallPlans: number;
  snapshots: number;
}

interface SweeperState {
  timer: ReturnType<typeof setInterval> | null;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (snapshot-store.ts precedent)
  var __skillPlanSweeper: SweeperState | undefined;
}

const state: SweeperState =
  globalThis.__skillPlanSweeper ?? (globalThis.__skillPlanSweeper = { timer: null });

/**
 * Reclaim everything whose TTL has passed, once.
 *
 * Plans before snapshots: a snapshot is only a candidate once the plan holding
 * its reference is gone.
 *
 * @param options.now Epoch milliseconds to judge expiry against, for tests
 */
export function runSkillPlanSweep(options: { now?: number } = {}): SkillPlanSweepResult {
  const now = options.now ?? Date.now();
  const installPlans = sweepSkillInstallPlans({ now });
  const uninstallPlans = sweepSkillUninstallPlans({ now });
  const snapshots = isSkillSnapshotStoreInitialized() ? sweepSkillSnapshots({ now }) : 0;
  return { installPlans, uninstallPlans, snapshots };
}

/**
 * Start the sweeper if it is not already running. Safe to call on every request.
 */
export function ensureSkillPlanSweeper(): void {
  if (state.timer) return;

  const timer = setInterval(() => {
    try {
      const result = runSkillPlanSweep();
      if (result.installPlans || result.uninstallPlans || result.snapshots) {
        logger.debug('skill-plan-sweep', { ...result });
      }
    } catch (error) {
      logger.warn('skill-plan-sweep-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, SKILL_PLAN_SWEEP_INTERVAL_MS);

  timer.unref();
  state.timer = timer;
}

/** @internal */
export function stopSkillPlanSweeperForTesting(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** @internal Handle of the running interval, for `unref` assertions. */
export function getSkillPlanSweeperTimerForTesting(): ReturnType<typeof setInterval> | null {
  return state.timer;
}
