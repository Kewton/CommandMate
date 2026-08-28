/**
 * Tailscale Serve Provider — stub (Issue #1937, R1).
 *
 * R3 replaces the body of this file. Until then `detect()` always reports
 * unavailable, which is the honest answer: nothing here can serve anything.
 *
 * The stub exists so R9 can wire the orchestrator against the real registry
 * instead of a test double, and so the selection rule and the §6.3 skip rule
 * are pinned by tests before either Provider is written.
 *
 * R3 must not add `reset()` / `cleanupAll()`: Tailscale Serve config is
 * persistent state owned by tailscaled that the user may already be using for
 * their own services, and there is no way to restore it once deleted. Its
 * `stop()` reverts only `owned.revert` minus `preexisting.keys` — see
 * `planStop()` in `./types`.
 */
import {
  planStop,
  type RemoteHandle,
  type RemoteProvider,
  type ProviderDetection,
  type StopOutcome,
} from './types';

/** Shown to the user, and asserted by tests, until R3 lands. */
export const TAILSCALE_NOT_IMPLEMENTED_REASON = 'not implemented (R2/R3)';

export const tailscaleProvider: RemoteProvider = {
  id: 'tailscale-serve',

  async detect(): Promise<ProviderDetection> {
    return { available: false, ready: false, reason: TAILSCALE_NOT_IMPLEMENTED_REASON };
  },

  async start(): Promise<RemoteHandle> {
    throw new Error(`tailscale-serve: ${TAILSCALE_NOT_IMPLEMENTED_REASON}`);
  },

  async stop(handle: RemoteHandle): Promise<StopOutcome> {
    // The stub cannot actuate a revert, but it can still classify correctly:
    // the split between "ours to undo" and "the user's, leave it" is R1's rule,
    // not R3's. Reporting a skip the stub could not have performed is exactly
    // the visibility §6.3-2 asks for.
    const plan = planStop(handle);
    const pending = Object.keys(plan.revert);
    const warnings: string[] = [];
    if (pending.length > 0) {
      warnings.push(
        `tailscale-serve: cannot revert ${pending.join(', ')} (${TAILSCALE_NOT_IMPLEMENTED_REASON})`,
      );
    }
    if (handle.owned.pid !== null) {
      warnings.push(
        `tailscale-serve: leaving pid ${handle.owned.pid} alone (${TAILSCALE_NOT_IMPLEMENTED_REASON})`,
      );
    }
    return { reverted: warnings.length === 0, skipped: plan.skipped, warnings };
  },
};
