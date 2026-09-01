/**
 * Real-dictionary i18n guard for `common.settings.defaultSurfaceMode`
 * (Issue #2201).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the card's own component test stays green even if every key added by this
 * Issue were missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * `settings.defaultSurfaceMode.mode.chat` — as the label of a radio button,
 * which is the only thing naming the choice. This file is what stands between
 * those two facts.
 *
 * The per-mode keys are pinned against the runtime vocabulary rather than a
 * hand-written list, because the card builds them by interpolation
 * (`t(\`settings.defaultSurfaceMode.mode.${mode}\`)`) from whatever the server
 * sends in `available` — which is derived from `VALID_SURFACE_MODES`. Shipping
 * a third mode without its two labels is exactly the drift this catches.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { VALID_SURFACE_MODES } from '@/types/ui-state';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadCommon(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

/** Every fixed `settings.defaultSurfaceMode.*` key the card requests. */
const KEYS = [
  'settings.defaultSurfaceMode.title',
  'settings.defaultSurfaceMode.description',
  'settings.defaultSurfaceMode.appliesToNew',
  'settings.defaultSurfaceMode.saving',
  'settings.defaultSurfaceMode.saved',
  'settings.defaultSurfaceMode.configured',
  'settings.defaultSurfaceMode.usingBuiltIn',
  'settings.defaultSurfaceMode.saveError',
  'settings.defaultSurfaceMode.loadError',
];

describe('[#2201] common.settings.defaultSurfaceMode i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every fixed key the card requests`, () => {
      const dict = loadCommon(locale);
      for (const key of KEYS) {
        const value = resolve(dict, key);
        expect(value, `${locale}: ${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} labels and describes every mode in the vocabulary`, () => {
      const dict = loadCommon(locale);
      for (const mode of VALID_SURFACE_MODES) {
        for (const group of ['mode', 'hint']) {
          const key = `settings.defaultSurfaceMode.${group}.${mode}`;
          const value = resolve(dict, key);
          expect(value, `${locale}: ${key}`).toBeTypeOf('string');
          expect(String(value).trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
        }
      }
    });
  }

  it('has the same key set in both locales', () => {
    const pick = (locale: string) =>
      resolve(loadCommon(locale), 'settings.defaultSurfaceMode') as Record<string, unknown>;
    expect(Object.keys(pick('ja')).sort()).toEqual(Object.keys(pick('en')).sort());
    expect(Object.keys(pick('ja').mode as object).sort()).toEqual(
      Object.keys(pick('en').mode as object).sort()
    );
    expect(Object.keys(pick('ja').hint as object).sort()).toEqual(
      Object.keys(pick('en').hint as object).sort()
    );
  });
});
