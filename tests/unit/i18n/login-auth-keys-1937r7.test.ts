/**
 * Real-dictionary i18n guard for /login (Issue #1937 R7).
 *
 * R7 deletes 10 of the 13 `login.qr.*` keys. Deleting one too many is invisible
 * to every other gate: `src/i18n.ts` has no `onError` / `getMessageFallback`, so
 * a missing key renders as the raw key path at runtime rather than throwing, and
 * `tests/setup.ts` mocks `next-intl` with a function that returns the key path
 * itself - which is exactly what a missing key would render. A component test
 * therefore passes for a key that exists in NO dictionary at all.
 *
 * This file reads `locales/{en,ja}/auth.json` off disk instead, so it fails on
 * over-deletion, and on a key removed from one locale only.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/**
 * The three `login.qr.*` keys R7 must KEEP. `login/page.tsx` maps each
 * `useFragmentLogin` error key onto one of them; deleting any breaks the error
 * banner of the auto-login path that R7 explicitly leaves in place.
 */
const SURVIVING_QR_KEYS = [
  'login.qr.autoLoginError',
  'login.qr.tokenExpiredOrInvalid',
  'login.qr.rateLimited',
] as const;

/** Added by R6 for the pairing flow; R7 must not touch them. */
const PAIRING_KEYS = [
  'login.pairing.inProgress',
  'login.pairing.invalidCode',
  'login.pairing.expired',
] as const;

/** QrCodeGenerator-only keys, deleted with the component. */
const REMOVED_QR_KEYS = [
  'login.qr.sectionTitle',
  'login.qr.urlLabel',
  'login.qr.urlPlaceholder',
  'login.qr.tokenLabel',
  'login.qr.tokenPlaceholder',
  'login.qr.securityNotice',
  'login.qr.showQrButton',
  'login.qr.hideQrButton',
  'login.qr.qrSecurityWarning',
  'login.qr.httpsWarning',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'auth.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

/** Dot-paths of every leaf string, so key SETS can be compared across locales. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafKeys(value as Record<string, unknown>, full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

describe('/login auth.json keys after the QR removal (Issue #1937 R7)', () => {
  it.each(LOCALES)('%s keeps every key login/page.tsx resolves', (locale) => {
    const dict = load(locale);
    for (const key of [...SURVIVING_QR_KEYS, ...PAIRING_KEYS]) {
      const value = resolve(dict, key);
      expect(value, `locales/${locale}/auth.json is missing ${key}`).toBeTypeOf('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES)('%s dropped every QrCodeGenerator-only key', (locale) => {
    const dict = load(locale);
    for (const key of REMOVED_QR_KEYS) {
      expect(resolve(dict, key), `locales/${locale}/auth.json still carries ${key}`).toBeUndefined();
    }
  });

  it.each(LOCALES)('%s leaves login.qr with exactly the three surviving keys', (locale) => {
    const section = resolve(load(locale), 'login.qr') as Record<string, unknown>;
    expect(Object.keys(section).sort()).toEqual(
      SURVIVING_QR_KEYS.map((k) => k.replace('login.qr.', '')).sort(),
    );
  });

  it('en and ja declare exactly the same auth keys', () => {
    // Guards the half-applied edit: 10 keys removed from one locale only.
    expect(leafKeys(load('ja'))).toEqual(leafKeys(load('en')));
  });

  it('every surviving key is actually referenced by login/page.tsx', () => {
    // Otherwise "keep these three" degrades into three orphaned strings that
    // nobody notices are dead.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../src/app/login/page.tsx'),
      'utf-8',
    );
    for (const key of [...SURVIVING_QR_KEYS, ...PAIRING_KEYS]) {
      expect(source, `src/app/login/page.tsx never resolves ${key}`).toContain(`t('${key}')`);
    }
  });

  it('no source file references a removed key', () => {
    const roots = ['src'];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf-8');
          for (const key of REMOVED_QR_KEYS) {
            if (content.includes(key)) hits.push(`${full}: ${key}`);
          }
        }
      }
    };
    for (const root of roots) walk(path.resolve(__dirname, '../../..', root));
    expect(hits).toEqual([]);
  });
});
