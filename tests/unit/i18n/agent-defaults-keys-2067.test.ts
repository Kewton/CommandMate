/**
 * Real-dictionary i18n guard for the `schedule.agentDefaults*` keys
 * (Issue #2067).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the panel's component test stays green even if every key added by this
 * Issue were missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * string `agentDefaultsApplyConfirm` — inside a confirmation dialog, where the
 * sentence explaining how many branches are about to change IS the safeguard.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadSchedule(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'schedule.json'), 'utf-8'));
}

/** Every `agentDefaults*` key the panel requests at runtime. */
const KEYS = [
  'agentDefaults',
  'agentDefaultsDescription',
  'agentDefaultsSetDefault',
  'agentDefaultsSaved',
  'agentDefaultsSaveError',
  'agentDefaultsApply',
  'agentDefaultsApplyScope',
  'agentDefaultsEligible',
  'agentDefaultsEligibleUnknown',
  'agentDefaultsRepositoryLabel',
  'agentDefaultsRepoDeclared',
  'agentDefaultsApplyConfirm',
  'agentDefaultsApplied',
  'agentDefaultsApplyError',
  'agentDefaultsCountError',
  'agentDefaultsRetry',
  'agentDefaultsInvalidRoster',
];

/** Keys whose message MUST carry an interpolation placeholder. */
const PLACEHOLDERS: Record<string, string[]> = {
  agentDefaultsEligible: ['{count}'],
  agentDefaultsApplyConfirm: ['{count}', '{agents}'],
  agentDefaultsApplied: ['{count}'],
  agentDefaultsRepositoryLabel: ['{repository}'],
  agentDefaultsInvalidRoster: ['{min}', '{max}'],
};

describe('[#2067] schedule.agentDefaults* i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the panel requests`, () => {
      const dict = loadSchedule(locale);
      for (const key of KEYS) {
        const value = dict[key];
        expect(value, `${locale}: ${key}`).toBeTypeOf('string');
        expect((value as string).length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the interpolation placeholders the panel passes`, () => {
      const dict = loadSchedule(locale);
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        const value = dict[key] as string;
        for (const token of tokens) {
          expect(value, `${locale}: ${key}`).toContain(token);
        }
      }
    });
  }

  for (const locale of LOCALES) {
    it(`${locale} gives every agentDefaults* key its own wording`, () => {
      // Issue #2067 review: `agentDefaults` (the disclosure header) and
      // `agentDefaultsSetDefault` (the button inside it) shipped as the same
      // Japanese sentence, so the panel read as a heading repeated as a button.
      // Two keys that always render together and always say the same thing is a
      // copy bug that only a human reading the screen would otherwise catch.
      const dict = loadSchedule(locale);
      const seen = new Map<string, string>();
      for (const key of KEYS) {
        const value = dict[key] as string;
        expect(seen.get(value), `${locale}: ${key} duplicates ${seen.get(value)}`).toBeUndefined();
        seen.set(value, key);
      }
    });
  }

  it('has the same agentDefaults* key set in both locales', () => {
    const keysOf = (locale: string): string[] =>
      Object.keys(loadSchedule(locale))
        .filter((key) => key.startsWith('agentDefaults'))
        .sort();
    expect(keysOf('ja')).toEqual(keysOf('en'));
    expect(keysOf('en')).toEqual([...KEYS].sort());
  });
});
