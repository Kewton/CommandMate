/**
 * Integration Tests: i18n Translation Key Parity
 *
 * Ensures en/ja translation files have matching keys across all namespaces.
 * Detects missing keys and parameter placeholder mismatches to prevent runtime errors.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SUPPORTED_LOCALES } from '@/config/i18n-config';

const LOCALES_DIR = path.resolve(__dirname, '../../locales');
const NAMESPACES = ['common', 'worktree', 'autoYes', 'error', 'prompt'] as const;

/**
 * Recursively extract all keys from a nested object.
 * Returns dot-separated key paths (e.g. "session.confirmKill").
 */
function getNestedKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys.push(...getNestedKeys(obj[key] as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys.sort();
}

/**
 * Extract parameter placeholders like {name}, {tool} from a translation string.
 */
function extractPlaceholders(value: string): string[] {
  const matches = value.match(/\{[^}]+\}/g);
  return matches ? matches.sort() : [];
}

/**
 * Recursively get all leaf values with their key paths.
 */
function getLeafValues(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      for (const [k, v] of getLeafValues(obj[key] as Record<string, unknown>, fullKey)) {
        result.set(k, v);
      }
    } else if (typeof obj[key] === 'string') {
      result.set(fullKey, obj[key] as string);
    }
  }
  return result;
}

function loadJson(locale: string, namespace: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('i18n Translation Key Parity', () => {
  for (const namespace of NAMESPACES) {
    describe(`namespace: ${namespace}`, () => {
      it(`should have matching keys between en and ja`, () => {
        const enJson = loadJson('en', namespace);
        const jaJson = loadJson('ja', namespace);

        const enKeys = getNestedKeys(enJson);
        const jaKeys = getNestedKeys(jaJson);

        const missingInJa = enKeys.filter(k => !jaKeys.includes(k));
        const missingInEn = jaKeys.filter(k => !enKeys.includes(k));

        expect(missingInJa, `Keys in en but missing in ja: ${missingInJa.join(', ')}`).toEqual([]);
        expect(missingInEn, `Keys in ja but missing in en: ${missingInEn.join(', ')}`).toEqual([]);
      });

      it(`should have matching parameter placeholders between en and ja`, () => {
        const enJson = loadJson('en', namespace);
        const jaJson = loadJson('ja', namespace);

        const enValues = getLeafValues(enJson);
        const jaValues = getLeafValues(jaJson);

        for (const [key, enValue] of enValues) {
          const jaValue = jaValues.get(key);
          if (jaValue === undefined) continue; // Key mismatch caught by other test

          const enPlaceholders = extractPlaceholders(enValue);
          const jaPlaceholders = extractPlaceholders(jaValue);

          expect(
            jaPlaceholders,
            `Placeholder mismatch for "${key}": en=${JSON.stringify(enPlaceholders)}, ja=${JSON.stringify(jaPlaceholders)}`
          ).toEqual(enPlaceholders);
        }
      });
    });
  }

  it('should cover all supported locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of NAMESPACES) {
        const filePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
        expect(fs.existsSync(filePath), `Missing file: ${filePath}`).toBe(true);
      }
    }
  });
});
