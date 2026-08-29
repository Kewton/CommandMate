/**
 * Cloudflare Quick Tunnel Provider — stub (Issue #1937, R1).
 *
 * R2 replaces the body of this file. Until then `detect()` always reports
 * unavailable, which is the honest answer: nothing here can serve anything.
 *
 * Quick Tunnel writes no persistent Provider configuration, so R2's `start()`
 * will return `preexisting: null` and its `stop()` will only signal the child
 * process it spawned (`owned.pid`). It still routes through `planStop()` so the
 * two Providers cannot drift apart on the §6.3 rule.
 */
import {
  planStop,
  type RemoteHandle,
  type RemoteProvider,
  type ProviderDetection,
  type StopOutcome,
} from './types';

/** Shown to the user, and asserted by tests, until R2 lands. */
export const CLOUDFLARE_NOT_IMPLEMENTED_REASON = 'not implemented (R2/R3)';

export const cloudflareProvider: RemoteProvider = {
  id: 'cloudflare-quick',

  async detect(): Promise<ProviderDetection> {
    return { available: false, ready: false, reason: CLOUDFLARE_NOT_IMPLEMENTED_REASON };
  },

  async start(): Promise<RemoteHandle> {
    throw new Error(`cloudflare-quick: ${CLOUDFLARE_NOT_IMPLEMENTED_REASON}`);
  },

  async stop(handle: RemoteHandle): Promise<StopOutcome> {
    // See the note in `./tailscale`: classification is R1's rule and works
    // here; actuation is R2's and does not.
    const plan = planStop(handle);
    const pending = Object.keys(plan.revert);
    const warnings: string[] = [];
    if (pending.length > 0) {
      warnings.push(
        `cloudflare-quick: cannot revert ${pending.join(', ')} (${CLOUDFLARE_NOT_IMPLEMENTED_REASON})`,
      );
    }
    if (handle.owned.pid !== null) {
      warnings.push(
        `cloudflare-quick: leaving pid ${handle.owned.pid} alone (${CLOUDFLARE_NOT_IMPLEMENTED_REASON})`,
      );
    }
    return { reverted: warnings.length === 0, skipped: plan.skipped, warnings };
  },
};
