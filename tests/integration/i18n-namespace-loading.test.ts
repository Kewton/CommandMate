/**
 * Integration Tests: i18n Namespace Loading
 *
 * Verifies that all translation namespaces can be loaded for every supported locale.
 * Ensures namespace file names match what src/i18n.ts expects.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';

const LOCALES_DIR = path.resolve(__dirname, '../../locales');

/**
 * The 6 namespaces referenced by src/i18n.ts getRequestConfig().
 * Must stay in sync with the import list there.
 * Issue #331: Added 'auth' namespace
 */
const EXPECTED_NAMESPACES = ['common', 'worktree', 'autoYes', 'error', 'prompt', 'auth'] as const;

describe('i18n Namespace Loading', () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(`locale: ${locale}`, () => {
      for (const namespace of EXPECTED_NAMESPACES) {
        it(`should load ${namespace} namespace`, async () => {
          const mod = await import(`../../locales/${locale}/${namespace}.json`);
          expect(mod.default).toBeDefined();
          expect(typeof mod.default).toBe('object');
        });

        it(`${namespace} namespace should not be empty`, () => {
          const filePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          expect(Object.keys(content).length).toBeGreaterThan(0);
        });
      }
    });
  }

  it('should have exactly 6 namespace files per locale matching src/i18n.ts', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const localeDir = path.join(LOCALES_DIR, locale);
      const files = fs.readdirSync(localeDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort();

      const expected = [...EXPECTED_NAMESPACES].sort();
      expect(
        files,
        `Namespace files for ${locale} do not match expected namespaces`
      ).toEqual(expected);
    }
  });
});
