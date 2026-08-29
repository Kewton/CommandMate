/**
 * Pins the registry's responsibility boundary (Issue #1937, design §6.2).
 *
 * The registry probes and orders. It does not choose, and it does not prompt.
 *
 * That split is not tidiness. "Prefer Tailscale, and never fall back to a
 * public Cloudflare tunnel on its own" is a rule about *selection*: exposing
 * the machine through a third party has to be a decision the user makes, and
 * the code that asks them is the same code that knows whether the session is
 * interactive and whether `--yes` was passed. Fold that into a probe helper and
 * the irreversible step happens inside something that reads like a lookup.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  createRemoteProviders,
  detectRemoteProviders,
  REMOTE_PROVIDER_ORDER,
} from '@/lib/remote/provider-registry';
import * as registry from '@/lib/remote/provider-registry';
import type { ProviderDetection, RemoteProvider, RemoteProviderId } from '@/lib/remote/types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REGISTRY_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'src/lib/remote/provider-registry.ts'),
  'utf-8',
);

function fakeProvider(
  id: RemoteProviderId,
  detection: ProviderDetection | (() => Promise<ProviderDetection>),
): RemoteProvider {
  return {
    id,
    detect: typeof detection === 'function' ? detection : async () => detection,
    start: async () => {
      throw new Error('unused');
    },
    stop: async () => ({ reverted: true, skipped: [], warnings: [] }),
  };
}

describe('preference order', () => {
  it('prefers Tailscale over Cloudflare', () => {
    // Tailscale reaches only the user's own tailnet; the Quick Tunnel is the
    // public internet. Order is data here, never control flow.
    expect(REMOTE_PROVIDER_ORDER).toEqual(['tailscale-serve', 'cloudflare-quick']);
  });

  it('ships both Providers in that order', () => {
    expect(createRemoteProviders().map((p) => p.id)).toEqual([...REMOTE_PROVIDER_ORDER]);
  });

  it('returns candidates in preference order regardless of input order', async () => {
    const candidates = await detectRemoteProviders([
      fakeProvider('cloudflare-quick', { available: true, ready: true }),
      fakeProvider('tailscale-serve', { available: true, ready: true }),
    ]);
    expect(candidates.map((c) => c.provider.id)).toEqual([
      'tailscale-serve',
      'cloudflare-quick',
    ]);
  });
});

describe('probing', () => {
  it('runs detect() once per Provider and returns every result', async () => {
    const tailscaleDetect = vi.fn(async () => ({
      available: true,
      ready: false,
      version: '1.80.0',
      reason: 'logged out',
    }));
    const cloudflareDetect = vi.fn(async () => ({
      available: true,
      ready: true,
      version: '2025.4.0',
    }));

    const candidates = await detectRemoteProviders([
      fakeProvider('tailscale-serve', tailscaleDetect),
      fakeProvider('cloudflare-quick', cloudflareDetect),
    ]);

    expect(tailscaleDetect).toHaveBeenCalledTimes(1);
    expect(cloudflareDetect).toHaveBeenCalledTimes(1);
    // Unusable candidates come back too: the orchestrator needs the preferred
    // Provider's `reason` to explain why it is asking instead of proceeding.
    expect(candidates).toHaveLength(2);
    expect(candidates[0].detection).toEqual({
      available: true,
      ready: false,
      version: '1.80.0',
      reason: 'logged out',
    });
    expect(candidates[1].detection.ready).toBe(true);
  });

  it('keeps available and ready separate', async () => {
    // Tailscale installed but logged out is exactly the case the two-value
    // split exists for: available, not ready, with the reason to show.
    const [tailscale] = await detectRemoteProviders([
      fakeProvider('tailscale-serve', {
        available: true,
        ready: false,
        reason: 'not logged in to a tailnet',
      }),
    ]);
    expect(tailscale.detection.available).toBe(true);
    expect(tailscale.detection.ready).toBe(false);
  });

  it('reports a throwing detect() as unavailable instead of failing the probe', async () => {
    // A broken `tailscale` binary must not hide the fact that `cloudflared`
    // exists — otherwise one bad install looks like "no way to go remote".
    const candidates = await detectRemoteProviders([
      fakeProvider('tailscale-serve', async () => {
        throw new Error('ENOENT');
      }),
      fakeProvider('cloudflare-quick', { available: true, ready: true }),
    ]);

    expect(candidates[0].detection).toEqual({
      available: false,
      ready: false,
      reason: 'detect() failed: ENOENT',
    });
    expect(candidates[1].detection.ready).toBe(true);
  });

  it('probes the shipped stubs without throwing', async () => {
    const candidates = await detectRemoteProviders();
    expect(candidates.map((c) => c.provider.id)).toEqual([...REMOTE_PROVIDER_ORDER]);
    expect(candidates.every((c) => c.detection.available === false)).toBe(true);
    expect(candidates.every((c) => c.detection.ready === false)).toBe(true);
  });
});

describe('responsibility boundary (design §6.2)', () => {
  it('exports no selection helper', () => {
    // Exact equality. A future `selectProvider()` / `pickProvider()` here can
    // only land by deleting this list, and that deletion is the review signal.
    expect(Object.keys(registry).sort()).toEqual([
      'REMOTE_PROVIDER_ORDER',
      'createRemoteProviders',
      'detectRemoteProviders',
    ]);
  });

  it('never returns a single winner', async () => {
    // Even when exactly one Provider is ready, the registry hands back both.
    // Narrowing to one here would be the auto-fallback the Issue forbids,
    // written as a convenience.
    const candidates = await detectRemoteProviders([
      fakeProvider('tailscale-serve', { available: false, ready: false, reason: 'absent' }),
      fakeProvider('cloudflare-quick', { available: true, ready: true }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].provider.id).toBe('tailscale-serve');
  });

  it('imports only its own siblings', () => {
    // Asserted on the module graph rather than on raw text, so the file's own
    // prose about `~/.commandmate/remote.json` cannot trip it — and so it stays
    // a real check instead of a grep that a reworded comment could satisfy.
    //
    // What the exact list buys: no `fs`/`os`/`path` means the registry cannot
    // read the state file (§6.2 puts persistence in the orchestrator, because a
    // registry that can open it is one refactor away from "clean up whatever
    // the state file forgot"), and no prompt module means it cannot ask the
    // question that `--yes` is supposed to answer.
    const specifiers = [
      // Anchored to statements starting a line, so a quoted phrase inside a
      // comment is not mistaken for a module. (It was, on the first run.)
      ...REGISTRY_SOURCE.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...REGISTRY_SOURCE.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    expect([...new Set(specifiers)].sort()).toEqual(['./cloudflare', './tailscale', './types']);
  });
});
