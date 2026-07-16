/**
 * Real-dictionary guard for the `notifications.push` keys (Issue #1308).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key missing from one
 * locale surfaces raw in production. These bodies are worse than most: they are
 * built by the background poller and delivered to a device, so nobody sees the
 * breakage in the UI first. Mirrors common-keys / home-keys.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadPush(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'notifications.json');
  const dict = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { push?: Record<string, unknown> };
  return dict.push ?? {};
}

/** Every body key push-sender resolves at runtime. */
const PUSH_KEYS = [
  'promptWaitingWithExcerpt',
  'promptWaiting',
  'completionWithExcerpt',
  'completion',
] as const;

/** Keys whose copy must carry the placeholder push-sender substitutes. */
const EXCERPT_KEYS = ['promptWaitingWithExcerpt', 'completionWithExcerpt'] as const;

describe('notifications.push dictionary', () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(`locale: ${locale}`, () => {
      const push = loadPush(locale);

      for (const key of PUSH_KEYS) {
        it(`defines a non-empty string for ${key}`, () => {
          expect(typeof push[key], `notifications.push.${key} missing in ${locale}`).toBe('string');
          expect((push[key] as string).trim().length).toBeGreaterThan(0);
        });
      }

      for (const key of EXCERPT_KEYS) {
        it(`keeps the {excerpt} placeholder in ${key}`, () => {
          expect(push[key] as string).toContain('{excerpt}');
        });
      }

      it('has no keys beyond the ones push-sender reads', () => {
        expect(Object.keys(push).sort()).toEqual([...PUSH_KEYS].sort());
      });
    });
  }

  it('translates every body — no locale reuses another locale\'s wording', () => {
    for (const key of PUSH_KEYS) {
      const en = loadPush('en')[key] as string;
      const ja = loadPush('ja')[key] as string;
      expect(ja, `notifications.push.${key} is untranslated in ja`).not.toBe(en);
    }
  });

  it('preserves the pre-i18n Japanese wording byte-for-byte', () => {
    // These are the literals push-sender hardcoded before #1308. Japanese users
    // must not notice the migration at all.
    expect(loadPush('ja')).toEqual({
      promptWaitingWithExcerpt: '応答待ち: {excerpt}',
      promptWaiting: '応答待ちです',
      completionWithExcerpt: '完了: {excerpt}',
      completion: 'セッションが完了しました',
    });
  });
});
