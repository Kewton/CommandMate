/**
 * Unit tests for the four loop guards (Issue #2377).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELAY_TTL_MS,
  MAX_OPEN_RELAYS_PER_PAIR,
  MAX_RELAY_HOPS,
  MAX_RELAY_TTL_MS,
  MIN_RELAY_TTL_MS,
  decideRelayCreation,
  isRelayRefusal,
  isSameEndpoint,
  resolveRelayTtlMs,
  type RelayCreationInput,
} from '@/lib/relay/relay-policy';

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function ask(overrides: Partial<RelayCreationInput> = {}) {
  return decideRelayCreation({
    from: A,
    to: B,
    parentHops: null,
    allowRelayChain: false,
    openBetween: 0,
    ...overrides,
  });
}

describe('decideRelayCreation', () => {
  it('permits an ordinary first delegation at depth 1', () => {
    const verdict = ask();

    expect(isRelayRefusal(verdict)).toBe(false);
    expect(verdict).toEqual({ ok: true, hops: 1 });
  });

  it('refuses a session relaying to itself', () => {
    const verdict = ask({ to: { ...A } });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_SELF_TARGET');
  });

  it('treats a different instance in the same worktree as a different session', () => {
    const verdict = ask({ to: { worktreeId: 'wt-a', instanceId: 'codex' } });

    expect(isRelayRefusal(verdict)).toBe(false);
  });

  it('refuses a chain by default', () => {
    const verdict = ask({ parentHops: 1 });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('permits a chain with the flag, one hop deeper', () => {
    expect(ask({ parentHops: 1, allowRelayChain: true })).toEqual({ ok: true, hops: 2 });
    expect(ask({ parentHops: 2, allowRelayChain: true })).toEqual({ ok: true, hops: 3 });
  });

  it('stops the chain at MAX_RELAY_HOPS even with the flag', () => {
    const verdict = ask({ parentHops: MAX_RELAY_HOPS, allowRelayChain: true });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_HOPS_EXCEEDED');
    // The flag widens the door; it does not remove the wall.
    expect(MAX_RELAY_HOPS).toBe(3);
  });

  it('refuses a second open relay in the same direction', () => {
    const verdict = ask({ openBetween: MAX_OPEN_RELAYS_PER_PAIR });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_DUPLICATE_PENDING');
  });

  it('reports the self target before anything else', () => {
    // All four conditions at once: the one the operator can act on first wins.
    const verdict = ask({
      to: { ...A },
      parentHops: 9,
      openBetween: 5,
    });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_SELF_TARGET');
  });

  it('reports the chain before the depth', () => {
    const verdict = ask({ parentHops: 9, allowRelayChain: false });

    expect(isRelayRefusal(verdict) && verdict.code).toBe('RELAY_CHAIN_BLOCKED');
  });

  it('carries a sentence an operator can act on with every refusal', () => {
    for (const verdict of [
      ask({ to: { ...A } }),
      ask({ parentHops: 1 }),
      ask({ parentHops: 3, allowRelayChain: true }),
      ask({ openBetween: 1 }),
    ]) {
      expect(isRelayRefusal(verdict)).toBe(true);
      if (isRelayRefusal(verdict)) expect(verdict.message.length).toBeGreaterThan(20);
    }
  });
});

describe('isSameEndpoint', () => {
  it('compares both halves', () => {
    expect(isSameEndpoint(A, { ...A })).toBe(true);
    expect(isSameEndpoint(A, { ...A, instanceId: 'claude-2' })).toBe(false);
    expect(isSameEndpoint(A, { ...A, worktreeId: 'wt-z' })).toBe(false);
  });
});

describe('resolveRelayTtlMs', () => {
  it('defaults to 24h', () => {
    expect(resolveRelayTtlMs(undefined)).toBe(DEFAULT_RELAY_TTL_MS);
    expect(DEFAULT_RELAY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('clamps rather than refusing', () => {
    expect(resolveRelayTtlMs(1)).toBe(MIN_RELAY_TTL_MS);
    expect(resolveRelayTtlMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_RELAY_TTL_MS);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(resolveRelayTtlMs(Number.NaN)).toBe(DEFAULT_RELAY_TTL_MS);
    expect(resolveRelayTtlMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RELAY_TTL_MS);
  });

  it('keeps a value inside the window', () => {
    expect(resolveRelayTtlMs(3 * 60 * 60 * 1000)).toBe(3 * 60 * 60 * 1000);
  });
});
