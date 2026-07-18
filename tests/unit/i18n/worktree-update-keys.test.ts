/**
 * Real-dictionary i18n guard for the `worktree.update` namespace (Issue #1198).
 *
 * The global next-intl mock (tests/setup.ts) echoes the requested key back, so
 * update-notification-banner.test.tsx stays green even if every key added by
 * this Issue were missing from locales/. Only this file reads the shipped
 * dictionaries, so it is the sole thing standing between a typo'd key and a
 * banner rendering "worktree.update.updateNow" at the user.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadWorktree(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'worktree.json');
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
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Every `update.*` key UpdateNotificationBanner requests at runtime. */
const UPDATE_KEYS = [
  // Issue #257 (pre-existing)
  'available',
  'latestVersion',
  'updateCommand',
  'viewRelease',
  'dataPreserved',
  'version',
  // Issue #1198 (one-click self-update)
  'updateNow',
  // Issue #1394 (npx guidance)
  'npxTitle',
  'npxDescription',
  'confirmTitle',
  'confirmDescription',
  'confirmButton',
  'starting',
  'updating',
  'updatingHint',
  'noRestartTitle',
  'noRestartDescription',
  'timeoutTitle',
  'timeoutDescription',
  'errorTitle',
  'errorNotGlobal',
  'errorInProgress',
  'errorGeneric',
  'logHint',
];

describe('worktree.update i18n keys (Issue #1198)', () => {
  it.each(['en', 'ja'])('%s resolves every update key the banner requests', (locale) => {
    const dict = loadWorktree(locale);
    for (const key of UPDATE_KEYS) {
      const value = resolve(dict, `update.${key}`);
      expect(value, `${locale} missing update.${key}`).toBeTruthy();
      expect(typeof value, `${locale}: update.${key} must be a string`).toBe('string');
    }
  });

  it('en and ja expose the identical set of worktree keys (parity)', () => {
    const en = leafKeys(loadWorktree('en')).sort();
    const ja = leafKeys(loadWorktree('ja')).sort();
    expect(en).toEqual(ja);
  });

  it('never uses a raw key path as an update string', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadWorktree(locale);
      for (const key of UPDATE_KEYS) {
        expect(
          resolve(dict, `update.${key}`) as string,
          `${locale}: update.${key} looks like a key passthrough`
        ).not.toMatch(/^(worktree\.)?update\./);
      }
    }
  });

  /**
   * Copy/pasting the English block into ja/ would leave the UI English for
   * Japanese users while every parity check above still passed. installType*
   * are exempt: they name npm/git verbatim on purpose.
   */
  it('translates the update strings rather than leaving them in English', () => {
    const en = loadWorktree('en');
    const ja = loadWorktree('ja');
    const translatable = UPDATE_KEYS.filter((key) => key !== 'latestVersion');
    for (const key of translatable) {
      expect(
        resolve(ja, `update.${key}`),
        `ja: update.${key} is still the English string`
      ).not.toBe(resolve(en, `update.${key}`));
    }
  });

  /**
   * These two are interpolated by the banner. A locale that dropped the
   * placeholder would render "Latest: v" / a log hint with no path.
   */
  it('keeps the interpolation placeholders in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadWorktree(locale);
      expect(resolve(dict, 'update.latestVersion') as string).toContain('{version}');
      expect(resolve(dict, 'update.confirmDescription') as string).toContain('{version}');
      expect(resolve(dict, 'update.logHint') as string).toContain('{path}');
    }
  });
});
