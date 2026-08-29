/**
 * Pins the Provider contract from Issue #1937 / design §6.1 and §6.3.
 *
 * The two rules being pinned both exist for the same reason: a Provider can
 * destroy configuration the user created and that CommandMate cannot restore.
 * Tailscale Serve config lives in tailscaled and may already be publishing the
 * user's own services; one `serve reset` and there is no undo.
 *
 * So the guarantee is structural, not documentary:
 *
 * - `RemoteProvider` has no `reset()` / `cleanupAll()`, and `stop()` takes a
 *   `RemoteHandle` and nothing else. "Read the Provider's whole config and tear
 *   it down" is then not expressible in the type at all.
 * - Anything present in both `owned` and `preexisting` is skipped, and the skip
 *   is reported. A silent skip and a silent delete look identical from outside.
 *
 * The interface assertions read the source rather than the compiled shape,
 * because a TypeScript interface leaves nothing behind at runtime to inspect.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { planStop, isPreexistingSnapshot, type RemoteHandle } from '@/lib/remote/types';
import { tailscaleProvider, TAILSCALE_NOT_IMPLEMENTED_REASON } from '@/lib/remote/tailscale';
import { cloudflareProvider, createCloudflareProvider } from '@/lib/remote/cloudflare';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TYPES_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, 'src/lib/remote/types.ts'),
  'utf-8',
);

/** Body of `export interface <name> { ... }`, brace-matched. */
function interfaceBody(source: string, name: string): string {
  const header = `export interface ${name} {`;
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`interface ${name} not found in src/lib/remote/types.ts`);
  let depth = 0;
  let i = start + header.length - 1;
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface ${name}`);
}

/** Top-level member names of an interface body, ignoring nested object types. */
function memberNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (depth === 0) {
      const match = /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*[(:]/.exec(line);
      if (match) names.push(match[1]);
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return names;
}

describe('RemoteProvider contract (design §6.1)', () => {
  it('exposes exactly id / detect / start / stop', () => {
    // Exact equality on purpose. Adding `reset()` or `cleanupAll()` — the two
    // shapes §6.3-1 forbids — cannot be done without deleting this assertion,
    // which is the point: the deletion is what a reviewer sees.
    expect(memberNames(interfaceBody(TYPES_SOURCE, 'RemoteProvider'))).toEqual([
      'id',
      'detect',
      'start',
      'stop',
    ]);
  });

  it('gives stop() a RemoteHandle and nothing else', () => {
    // A second argument — a config object, a "force" flag, a provider snapshot —
    // is how "tear down everything" gets back in.
    const body = interfaceBody(TYPES_SOURCE, 'RemoteProvider');
    const signature = /\bstop\((.*?)\)\s*:/.exec(body);
    expect(signature).not.toBeNull();
    expect(signature?.[1]).toBe('handle: RemoteHandle');
  });

  it('pins the RemoteHandle / ProviderDetection / StopOutcome shapes', () => {
    expect(memberNames(interfaceBody(TYPES_SOURCE, 'RemoteHandle'))).toEqual([
      'provider',
      'url',
      'owned',
      'preexisting',
    ]);
    // available vs ready is the split the selection rule is written against:
    // Tailscale can be installed and still unable to serve because the machine
    // is not logged in.
    expect(memberNames(interfaceBody(TYPES_SOURCE, 'ProviderDetection'))).toEqual([
      'available',
      'version',
      'ready',
      'reason',
    ]);
    expect(memberNames(interfaceBody(TYPES_SOURCE, 'StopOutcome'))).toEqual([
      'reverted',
      'skipped',
      'warnings',
    ]);
  });

  it('has both shipped Providers implement exactly that surface at runtime', () => {
    for (const provider of [tailscaleProvider, cloudflareProvider]) {
      expect(Object.keys(provider).sort()).toEqual(['detect', 'id', 'start', 'stop']);
    }
  });
});

describe('planStop: owned minus preexisting (design §6.3-2)', () => {
  const handleWith = (
    revert: Record<string, string> | null,
    preexisting: unknown,
  ): RemoteHandle => ({
    provider: 'tailscale-serve',
    url: 'https://host.example.ts.net',
    owned: { pid: null, revert },
    preexisting,
  });

  it('reverts what is owned and not preexisting', () => {
    const plan = planStop(handleWith({ '/': 'off', '/api': 'off' }, { keys: [], raw: null }));
    expect(plan.revert).toEqual({ '/': 'off', '/api': 'off' });
    expect(plan.skipped).toEqual([]);
  });

  it('skips - and reports - anything that was already there', () => {
    // The user was already serving `/grafana` before `remote up` ran. Reverting
    // it would delete their configuration, and nothing could put it back.
    const plan = planStop(
      handleWith(
        { '/': 'off', '/grafana': 'off' },
        { keys: ['/grafana'], raw: { '/grafana': 'http://127.0.0.1:3001' } },
      ),
    );
    expect(plan.revert).toEqual({ '/': 'off' });
    expect(plan.skipped).toEqual(['/grafana']);
  });

  it('reverts nothing when every owned key was preexisting', () => {
    const plan = planStop(
      handleWith({ '/': 'off' }, { keys: ['/'], raw: { '/': 'http://127.0.0.1:9999' } }),
    );
    expect(plan.revert).toEqual({});
    expect(plan.skipped).toEqual(['/']);
  });

  it('treats an unreadable snapshot as protecting nothing, not everything', () => {
    // Cloudflare Quick Tunnel persists nothing, so its `preexisting` is null.
    // Failing open here would strand owned state forever; failing closed is
    // wrong for the Provider that genuinely has none.
    expect(planStop(handleWith({ pid: 'kill' }, null)).revert).toEqual({ pid: 'kill' });
    expect(planStop(handleWith({ pid: 'kill' }, 'garbage')).revert).toEqual({ pid: 'kill' });
    expect(planStop(handleWith(null, null)).revert).toEqual({});
  });

  it('recognises only a real snapshot shape', () => {
    expect(isPreexistingSnapshot({ keys: ['/'], raw: null })).toBe(true);
    expect(isPreexistingSnapshot({ keys: [] })).toBe(true);
    expect(isPreexistingSnapshot({ keys: [1, 2] })).toBe(false);
    expect(isPreexistingSnapshot({ keys: 'not-an-array' })).toBe(false);
    expect(isPreexistingSnapshot(null)).toBe(false);
    expect(isPreexistingSnapshot(undefined)).toBe(false);
  });
});

describe('shipped Providers (cloudflare landed in R2; tailscale is still an R3 stub)', () => {
  it('has the tailscale stub report unavailable and not ready, with a reason', async () => {
    // `available: false` is the honest answer while nothing is implemented, and
    // it keeps the orchestrator's selection rule exercised end to end.
    await expect(tailscaleProvider.detect()).resolves.toEqual({
      available: false,
      ready: false,
      reason: TAILSCALE_NOT_IMPLEMENTED_REASON,
    });
  });

  it('has the tailscale stub refuse to start rather than pretending to', async () => {
    const opts = { port: 3000, signal: new AbortController().signal };
    await expect(tailscaleProvider.start(opts)).rejects.toThrow(/not implemented/);
  });

  it('keeps cloudflare available and ready in lockstep', async () => {
    // Deliberately machine-independent: whether `cloudflared` is installed
    // differs between a developer laptop and CI. The invariant does not — a
    // Quick Tunnel needs no account and no login, so "installed" and "usable
    // right now" are the same question. Tailscale is the Provider that has to
    // answer them separately, which is why `ProviderDetection` splits them.
    const detection = await cloudflareProvider.detect();
    expect(typeof detection.available).toBe('boolean');
    expect(detection.ready).toBe(detection.available);
  });

  it('has cloudflare refuse to start once the caller has aborted', async () => {
    // The abort is honoured before anything is spawned. An abort that raced a
    // spawn would leave a public URL running with no handle to stop it by.
    const spawn = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const provider = createCloudflareProvider({ spawn });
    await expect(provider.start({ port: 3000, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('routes stop() through planStop, so preexisting entries land in skipped', async () => {
    // Classification is R1's job; the Tailscale stub still cannot actuate a
    // revert. A stub that reported an empty `skipped` would be
    // indistinguishable from one that had quietly deleted the user's config.
    const handle: RemoteHandle = {
      provider: 'tailscale-serve',
      url: 'https://host.example.ts.net',
      owned: { pid: null, revert: { '/': 'off', '/grafana': 'off' } },
      preexisting: { keys: ['/grafana'], raw: { '/grafana': 'http://127.0.0.1:3001' } },
    };

    const outcome = await tailscaleProvider.stop(handle);
    expect(outcome.skipped).toEqual(['/grafana']);
    expect(outcome.reverted).toBe(false);
    expect(outcome.warnings.join(' ')).toContain('/');
    // The protected key must never appear as something the stub tried to undo.
    expect(outcome.warnings.some((w) => w.includes('/grafana'))).toBe(false);
  });

  it('reports a clean stop when there was nothing owned to undo', async () => {
    const outcome = await cloudflareProvider.stop({
      provider: 'cloudflare-quick',
      url: 'https://example.trycloudflare.com',
      owned: { pid: null, revert: null },
      preexisting: null,
    });
    expect(outcome).toEqual({ reverted: true, skipped: [], warnings: [] });
  });
});
