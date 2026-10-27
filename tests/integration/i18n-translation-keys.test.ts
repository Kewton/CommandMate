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
const NAMESPACES = ['common', 'worktree', 'autoYes', 'error', 'prompt', 'auth', 'home'] as const;

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
 * Split a message into its top-level `{...}` groups (nested braces kept whole).
 * Returns the text inside each group.
 */
function topLevelBraceGroups(value: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (value[i] === '}' && depth > 0) {
      depth--;
      if (depth === 0) groups.push(value.slice(start, i));
    }
  }
  return groups;
}

/**
 * Extract the argument names a translation string uses, as a sorted set.
 *
 * `{name}` counts as `name`. An ICU plural / select (`{name, plural, one {...} other {...}}`)
 * counts as `name`; its `#` and option texts are not arguments, but an argument
 * inside an option text (`{dir}` in `one {# file in {dir}}`) is.
 */
function extractPlaceholders(value: string): string[] {
  const names = new Set<string>();
  const collect = (message: string): void => {
    for (const group of topLevelBraceGroups(message)) {
      const parts = group.split(',');
      names.add(parts[0].trim());
      if (parts.length >= 3) {
        // `name, type, options...` — option bodies are messages themselves
        const options = parts.slice(2).join(',');
        for (const body of topLevelBraceGroups(options)) collect(body);
      }
    }
  };
  collect(value);
  return [...names].sort();
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

  // Issue #3913: the first plural message (autoYes.durationHours) — compare argument names
  describe('extractPlaceholders', () => {
    it('treats an ICU plural and a plain placeholder with the same argument as matching', () => {
      expect(extractPlaceholders('{hours, plural, one {# hour} other {# hours}}')).toEqual(
        extractPlaceholders('{hours}時間'),
      );
      expect(extractPlaceholders('{hours}時間')).toEqual(['hours']);
    });

    it('still reports a mismatch when the argument names differ', () => {
      expect(extractPlaceholders('{hours}')).not.toEqual(extractPlaceholders('{count}'));
      expect(extractPlaceholders('{hours, plural, one {# hour} other {# hours}}')).not.toEqual(
        extractPlaceholders('{count}件'),
      );
    });

    it('counts an argument inside a plural option text', () => {
      expect(extractPlaceholders('{n, plural, one {# file in {dir}} other {# files in {dir}}}')).toEqual([
        'dir',
        'n',
      ]);
    });

    it('reads plain placeholders as before', () => {
      expect(extractPlaceholders('Run {tool} on {name}')).toEqual(['name', 'tool']);
      expect(extractPlaceholders('no placeholders')).toEqual([]);
    });
  });

  it('should cover all supported locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of NAMESPACES) {
        const filePath = path.join(LOCALES_DIR, locale, `${namespace}.json`);
        expect(fs.existsSync(filePath), `Missing file: ${filePath}`).toBe(true);
      }
    }
  });
});
