/**
 * What a roster row's held badge says survives the row's `truncate` (Issue #4103).
 *
 * The line is clipped from the end, so what must stay readable has to come first:
 * the count on the "many" form, the word "unconfirmed" on the single form. The
 * pixels are measured in tests/e2e/pwa-update-toast-4103.spec.ts; this holds the
 * property that does not depend on the pane's width.
 */

import { describe, it, expect } from 'vitest';
import en from '../../../../locales/en/worktree.json';
import ja from '../../../../locales/ja/worktree.json';

const countComesFirst = (message: string): boolean => message.startsWith('{count}');
const aliasComesLast = (message: string): boolean => message.endsWith('{alias}');

describe.each([
  ['en', en.relay],
  ['ja', ja.relay],
] as const)('held badge wording: %s', (_locale, relay) => {
  it('the many form leads with the count', () => {
    expect(countComesFirst(relay.badgeHeldMany)).toBe(true);
  });

  it('the single form ends with the alias, so a long one cuts only itself', () => {
    expect(aliasComesLast(relay.badgeHeld)).toBe(true);
  });
});

describe('held badge wording: controls', () => {
  it('positive control: the wording before #4103 fails both checks', () => {
    for (const before of ['Unconfirmed deliveries ({count})', '配送未確認 {count} 件']) {
      expect(countComesFirst(before)).toBe(false);
    }
    for (const before of ['Delivery from {alias} unconfirmed', '{alias} からの配送が未確認']) {
      expect(aliasComesLast(before)).toBe(false);
    }
  });

  it('negative control: the chat strip, which has room for a sentence, is unchanged', () => {
    expect(en.relay.stripHeldMany).toBe(
      '{count} unconfirmed deliveries: check this pane, then settle them with relays resolve.'
    );
    expect(ja.relay.stripHeld).toBe('{alias} からの配送が未確認: 画面を確かめて relays resolve で片付けてください');
  });
});
