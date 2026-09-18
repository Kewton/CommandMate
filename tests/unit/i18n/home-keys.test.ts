/**
 * Unit-level i18n parity test for the `home` namespace (Issue #1072).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale would surface the raw key string in production and go undetected.
 * This test enforces full deep-key parity for the `home` namespace across
 * en / ja, mirroring the existing command-palette-keys parity test.
 *
 * Issue #2643 removed the Home dashboard and Issue #2649 removed Assistant
 * Chat, so the namespace now holds only the first-run checklist that `/` shows
 * when no repository is registered.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadHome(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'home.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Collect all dot-joined leaf key paths from a nested object. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dict);
}

describe('home i18n keys (Issue #1072)', () => {
  it.each(['en', 'ja'])('%s/home.json has non-empty values for every leaf', (locale) => {
    const dict = loadHome(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolve(dict, key), `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadHome('en')).sort();
    const ja = leafKeys(loadHome('ja')).sort();
    expect(en).toEqual(ja);
  });

  it.each(['en', 'ja'])('%s/home.json holds only the onboarding checklist (Issue #2649)', (locale) => {
    expect(Object.keys(loadHome(locale))).toEqual(['onboarding']);
  });

  /**
   * Issue #1199: OnboardingChecklist resolves these at runtime. The echoing
   * next-intl mock makes component tests blind to a missing dictionary entry.
   */
  it('includes the onboarding checklist keys', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of [
        'onboarding.title',
        'onboarding.dismiss',
        'onboarding.steps.registerRepository',
        'onboarding.steps.sendFirstMessage',
        'onboarding.actions.registerRepository',
        'onboarding.actions.sendFirstMessage',
      ]) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });

  /**
   * Issue #1274: key parity only proves ja *has* an entry, not that anyone
   * translated it — a copy-paste of the English value passes every other check
   * here and ships English text to a Japanese user.
   */
  it('translates every label rather than leaving it in English', () => {
    const en = loadHome('en');
    const ja = loadHome('ja');
    for (const key of leafKeys(en)) {
      expect(resolve(ja, key), `ja: ${key} is still the English string`).not.toBe(resolve(en, key));
    }
  });
});
