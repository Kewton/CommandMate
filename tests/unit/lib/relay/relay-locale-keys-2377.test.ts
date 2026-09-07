/**
 * Every relay label the UI can ask for exists in both dictionaries (#2377).
 *
 * The badges are rendered as `t(\`relay.\${badge.key}\`)`, which means a key the
 * resolver can produce and the dictionary does not hold does not throw and does
 * not render blank — next-intl renders the KEY, so the roster row would read
 * `worktree.relay.badgeAwaitingMany` in production and every unit test that
 * mocks `useTranslations` would still be green. This is the grep that catches
 * that, and it is written against the resolver's real output rather than against
 * a hand-copied list.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import en from '../../../../locales/en/worktree.json';
import ja from '../../../../locales/ja/worktree.json';
import { resolveRelayBadges, resolveRelayStrip } from '@/lib/relay/relay-badges';
import type { SessionRelay } from '@/lib/relay/types';

function relay(id: string, state: SessionRelay['state'] = 'pending'): SessionRelay {
  return {
    id,
    from: { worktreeId: 'wt-a', instanceId: 'claude' },
    to: { worktreeId: 'wt-b', instanceId: 'codex' },
    state,
    hops: 1,
    sentRequestId: null,
    pendingKind: null,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    deliveredAt: null,
  };
}

const aliasOf = () => 'Codex 2';

/** Every (key, titleKey) the resolver can emit, over every shape it can see. */
function everyKeyTheResolverCanEmit(): string[] {
  const inputs = [
    { owed: [], awaiting: [relay('a1')] },
    { owed: [], awaiting: [relay('a1'), relay('a2')] },
    { owed: [], awaiting: [relay('a1', 'prompt')] },
    { owed: [relay('o1')], awaiting: [] },
    { owed: [relay('o1'), relay('o2')], awaiting: [] },
  ];

  const keys = new Set<string>();
  for (const input of inputs) {
    const badges = resolveRelayBadges({ ...input, aliasOf });
    for (const badge of badges) {
      keys.add(badge.key);
      keys.add(badge.titleKey);
    }
    const strip = resolveRelayStrip(badges);
    if (strip) keys.add(strip.key);
  }
  return [...keys];
}

const RELAY_DICTIONARIES: Array<[string, Record<string, string>]> = [
  ['en', (en as Record<string, unknown>).relay as Record<string, string>],
  ['ja', (ja as Record<string, unknown>).relay as Record<string, string>],
];

describe('the relay namespace', () => {
  it('exists in both dictionaries', () => {
    for (const [locale, dictionary] of RELAY_DICTIONARIES) {
      expect(dictionary, `${locale} has no relay namespace`).toBeDefined();
    }
  });

  it('holds every key the badge resolver can emit', () => {
    const keys = everyKeyTheResolverCanEmit();
    // Not vacuous: the resolver really does produce several distinct keys.
    expect(keys.length).toBeGreaterThanOrEqual(8);

    for (const [locale, dictionary] of RELAY_DICTIONARIES) {
      for (const key of keys) {
        expect(dictionary[key], `${locale} is missing relay.${key}`).toBeTypeOf('string');
      }
    }
  });

  it('holds the keys the panes reference directly', () => {
    for (const [locale, dictionary] of RELAY_DICTIONARIES) {
      for (const key of ['historyBadge', 'historyBadgeTitle', 'historyCount']) {
        expect(dictionary[key], `${locale} is missing relay.${key}`).toBeTypeOf('string');
      }
    }
  });

  it('declares the same key set in both languages', () => {
    const [, enDict] = RELAY_DICTIONARIES[0];
    const [, jaDict] = RELAY_DICTIONARIES[1];

    expect(Object.keys(enDict).sort()).toEqual(Object.keys(jaDict).sort());
  });

  it('keeps every interpolation placeholder the resolver supplies', () => {
    const badges = resolveRelayBadges({
      owed: [relay('o1'), relay('o2')],
      awaiting: [relay('a1')],
      aliasOf,
    });

    for (const [, dictionary] of RELAY_DICTIONARIES) {
      for (const badge of badges) {
        const template = dictionary[badge.key];
        for (const param of Object.keys(badge.params)) {
          // A template that names a param the caller does not pass throws at
          // render time; one that omits a param the caller does pass silently
          // drops it. Only the first is a defect, and this is that check.
          const named = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
          expect(named.every((n) => n in badge.params)).toBe(true);
          expect(typeof param).toBe('string');
        }
      }
    }
  });
});
