/**
 * The launch's owed trust Enter (#3757) and the strict `respond` (#3756) never
 * both answer one trust screen: a hold keeps the Enter from being claimed, and
 * a recent claim is visible to the strict side.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  claimStartupTrust,
  clearStartupTrust,
  forgetStartupTrust,
  holdStartupTrust,
  isStartupTrustPending,
  markStartupTrustPending,
  wasStartupTrustClaimedWithin,
} from '@/lib/cli-tools/antigravity-startup-trust';

const SESSION = 'mcbd-antigravity-wt-3756';

afterEach(() => {
  clearStartupTrust();
});

describe('[#3756] the strict respond and the owed Enter', () => {
  it('without a hold the owed Enter is claimed exactly once, as before (negative control)', () => {
    markStartupTrustPending(SESSION);
    expect(claimStartupTrust(SESSION)).toBe(true);
    expect(claimStartupTrust(SESSION)).toBe(false);
  });

  it('while a strict answer holds the session, the owed Enter cannot be claimed', () => {
    markStartupTrustPending(SESSION);
    const release = holdStartupTrust(SESSION);
    expect(claimStartupTrust(SESSION)).toBe(false);
    expect(isStartupTrustPending(SESSION)).toBe(true);

    // The strict answer to the trust screen was the Enter: it drops the debt.
    forgetStartupTrust(SESSION);
    release();
    expect(claimStartupTrust(SESSION)).toBe(false);
  });

  it('a hold that ends without dropping the debt leaves it to be claimed', () => {
    markStartupTrustPending(SESSION);
    holdStartupTrust(SESSION)();
    expect(claimStartupTrust(SESSION)).toBe(true);
  });

  it('a claim is visible to the strict side for the quiet period', () => {
    markStartupTrustPending(SESSION);
    expect(wasStartupTrustClaimedWithin(SESSION, 10_000, 1_000)).toBe(false);
    claimStartupTrust(SESSION, 1_000);
    expect(wasStartupTrustClaimedWithin(SESSION, 10_000, 5_000)).toBe(true);
    expect(wasStartupTrustClaimedWithin(SESSION, 10_000, 11_000)).toBe(false);
  });
});
