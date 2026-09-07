/**
 * Unit tests for the roster badge rule (Issue #2377).
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { resolveRelayBadges, resolveRelayStrip } from '@/lib/relay/relay-badges';
import type { SessionRelay } from '@/lib/relay/types';

const A = { worktreeId: 'wt-a', instanceId: 'claude' };
const B = { worktreeId: 'wt-b', instanceId: 'codex' };

function relay(overrides: Partial<SessionRelay> = {}): SessionRelay {
  return {
    id: overrides.id ?? 'r1',
    from: overrides.from ?? A,
    to: overrides.to ?? B,
    state: overrides.state ?? 'pending',
    hops: overrides.hops ?? 1,
    sentRequestId: null,
    pendingKind: null,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    deliveredAt: null,
  };
}

const aliasOf = (endpoint: { instanceId: string }) => endpoint.instanceId.toUpperCase();

describe('resolveRelayBadges', () => {
  it('renders nothing for a session with no open relay', () => {
    expect(resolveRelayBadges({ owed: [], awaiting: [], aliasOf })).toEqual([]);
  });

  it('names the other end of a single wait', () => {
    const [badge] = resolveRelayBadges({ owed: [], awaiting: [relay()], aliasOf });

    expect(badge.tone).toBe('awaiting');
    expect(badge.key).toBe('badgeAwaiting');
    expect(badge.params).toEqual({ alias: 'CODEX' });
  });

  it('counts rather than names when several are outstanding', () => {
    const [badge] = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ id: 'r1' }), relay({ id: 'r2' })],
      aliasOf,
    });

    expect(badge.key).toBe('badgeAwaitingMany');
    expect(badge.params).toEqual({ count: 2 });
  });

  it('names who a single owed reply goes to', () => {
    const [badge] = resolveRelayBadges({ owed: [relay()], awaiting: [], aliasOf });

    expect(badge.tone).toBe('owed');
    expect(badge.key).toBe('badgeOwed');
    // The `from` end: the session that is owed the answer.
    expect(badge.params).toEqual({ alias: 'CLAUDE' });
  });

  it('puts the confirmation first, because it is the only one needing action', () => {
    const badges = resolveRelayBadges({
      owed: [relay({ id: 'owed' })],
      awaiting: [relay({ id: 'stuck', state: 'prompt' }), relay({ id: 'pending' })],
      aliasOf,
    });

    expect(badges.map((b) => b.tone)).toEqual(['prompt', 'awaiting', 'owed']);
  });

  it('does not count a prompt relay as an ordinary wait as well', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ state: 'prompt' })],
      aliasOf,
    });

    expect(badges.map((b) => b.tone)).toEqual(['prompt']);
  });

  it('carries a title key for every badge', () => {
    const badges = resolveRelayBadges({
      owed: [relay({ id: 'o1' }), relay({ id: 'o2' })],
      awaiting: [relay({ id: 'a1', state: 'prompt' })],
      aliasOf,
    });

    expect(badges.every((b) => b.titleKey.length > 0)).toBe(true);
  });
});

describe('resolveRelayStrip', () => {
  it('answers null for a session with nothing open', () => {
    expect(resolveRelayStrip([])).toBeNull();
  });

  it('takes the most urgent badge and switches to the strip wording', () => {
    const badges = resolveRelayBadges({
      owed: [relay({ id: 'owed' })],
      awaiting: [relay({ id: 'stuck', state: 'prompt' })],
      aliasOf,
    });

    expect(resolveRelayStrip(badges)).toMatchObject({ tone: 'prompt', key: 'stripPrompt' });
  });

  it('uses the plural strip wording when several are outstanding', () => {
    const badges = resolveRelayBadges({
      owed: [],
      awaiting: [relay({ id: 'r1' }), relay({ id: 'r2' })],
      aliasOf,
    });

    expect(resolveRelayStrip(badges)).toMatchObject({
      key: 'stripAwaitingMany',
      params: { count: 2 },
    });
  });

  it('uses the owed wording when that is all there is', () => {
    const badges = resolveRelayBadges({ owed: [relay()], awaiting: [], aliasOf });

    expect(resolveRelayStrip(badges)).toMatchObject({ tone: 'owed', key: 'stripOwed' });
  });
});
