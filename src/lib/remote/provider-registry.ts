/**
 * Provider registry for `commandmate remote` (Issue #1937, R1).
 *
 * What this module does: run every Provider's `detect()` and hand back the
 * results **in preference order**.
 *
 * What this module deliberately does NOT do, and why (§6.2):
 *
 * - It does not pick a Provider. "Tailscale first, and never fall back to a
 *   public tunnel on its own" is a rule about selection, not a property of
 *   either Provider. Putting it here would bury an irreversible decision —
 *   exposing the machine through a third party — inside a probe helper. The
 *   orchestrator (`src/cli/commands/remote.ts`, R9) reads this ordered list,
 *   applies the rule, and asks the user before anything public is created.
 * - It does not prompt. A prompt in here would have to re-derive
 *   interactive-vs-not per Provider, and the answer would be invisible to the
 *   caller that has to honour `--yes`.
 * - It does not know about `~/.commandmate/remote.json`. Persistence is the
 *   orchestrator's; a Provider that can read the state file is one refactor
 *   away from "clean up whatever the state file forgot".
 *
 * A test pins the export list of this module so that a future `selectProvider()`
 * cannot be added here without someone having to delete that assertion.
 */
import { cloudflareProvider } from './cloudflare';
import { tailscaleProvider } from './tailscale';
import type { ProviderDetection, RemoteProvider, RemoteProviderId } from './types';

/**
 * Preference order, most preferred first.
 *
 * Tailscale is first because it exposes the server only to the user's own
 * tailnet; the Cloudflare Quick Tunnel puts it on the public internet. The
 * order is data, not control flow — being second here never causes a fallback.
 */
export const REMOTE_PROVIDER_ORDER: readonly RemoteProviderId[] = [
  'tailscale-serve',
  'cloudflare-quick',
];

/** The shipped Providers, in `REMOTE_PROVIDER_ORDER`. */
export function createRemoteProviders(): RemoteProvider[] {
  return [tailscaleProvider, cloudflareProvider];
}

/** One Provider and what probing it just said. */
export interface ProviderCandidate {
  provider: RemoteProvider;
  detection: ProviderDetection;
}

/**
 * Probes every Provider and returns all of them in preference order.
 *
 * Every candidate comes back, including the unusable ones: the caller needs the
 * `reason` of the preferred Provider to explain why it is falling through to a
 * question rather than to a tunnel.
 *
 * A Provider whose `detect()` throws is reported as unavailable rather than
 * taking down the probe — a broken `tailscale` binary must not stop the user
 * from seeing that `cloudflared` exists.
 */
export async function detectRemoteProviders(
  providers: readonly RemoteProvider[] = createRemoteProviders(),
): Promise<ProviderCandidate[]> {
  const ordered = [...providers].sort(
    (a, b) => REMOTE_PROVIDER_ORDER.indexOf(a.id) - REMOTE_PROVIDER_ORDER.indexOf(b.id),
  );

  return Promise.all(
    ordered.map(async (provider) => ({
      provider,
      detection: await probe(provider),
    })),
  );
}

async function probe(provider: RemoteProvider): Promise<ProviderDetection> {
  try {
    return await provider.detect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, ready: false, reason: `detect() failed: ${message}` };
  }
}
