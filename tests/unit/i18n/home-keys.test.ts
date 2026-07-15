/**
 * Unit-level i18n parity test for the `home` namespace (Issue #1072).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale would surface the raw key string in production and go undetected.
 * This test enforces full deep-key parity for the `home` namespace across
 * en / ja, mirroring the existing command-palette-keys parity test.
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

describe('home i18n keys (Issue #1072)', () => {
  it.each(['en', 'ja'])('%s/home.json has non-empty values for every leaf', (locale) => {
    const dict = loadHome(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dict);
      expect(value, `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadHome('en')).sort();
    const ja = leafKeys(loadHome('ja')).sort();
    expect(en).toEqual(ja);
  });

  it('includes the heading title and subline count labels', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of ['title', 'running', 'waiting']) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });

  /**
   * Issue #1197: SessionOverviewTile / RecentSessionsList resolve these at
   * runtime. The global next-intl mock echoes keys, so a component test cannot
   * catch a missing dictionary entry — only a real-dictionary assert like this
   * stops `home.sessionOverview.title` from rendering verbatim in the UI.
   */
  it('includes the session overview tile and recent sessions keys', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of [
        'sessionOverview.title',
        'sessionOverview.recentSessions',
        'sessionOverview.viewAll',
        'recentSessions.empty',
      ]) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });

  /**
   * Issue #1199: OnboardingChecklist / RecentSessionsList resolve these at
   * runtime. Same rationale as the block above — the echoing next-intl mock
   * makes component tests blind to a missing dictionary entry.
   */
  it('includes the onboarding checklist and empty-state CTA keys', () => {
    for (const locale of ['en', 'ja']) {
      const keys = leafKeys(loadHome(locale));
      for (const expected of [
        'onboarding.title',
        'onboarding.dismiss',
        'onboarding.steps.registerRepository',
        'onboarding.steps.sendFirstMessage',
        'onboarding.actions.registerRepository',
        'onboarding.actions.sendFirstMessage',
        'recentSessions.cta',
      ]) {
        expect(keys, `${locale} missing ${expected}`).toContain(expected);
      }
    }
  });
});
