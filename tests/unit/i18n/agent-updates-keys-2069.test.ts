/**
 * Real-dictionary i18n guard for the `common.agentUpdates` namespace
 * (Issue #2069).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the card's own component test stays green even if every key added by this
 * Issue were missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * string `agentUpdates.restartWarning` at the user. This file is the only thing
 * standing between those two facts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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

/** Every `agentUpdates.*` key AgentUpdatesCard requests at runtime. */
const KEYS = [
  'agentUpdates.title',
  'agentUpdates.description',
  'agentUpdates.installed',
  'agentUpdates.notInstalled',
  'agentUpdates.available',
  'agentUpdates.dismissed',
  'agentUpdates.update',
  'agentUpdates.updating',
  'agentUpdates.running',
  'agentUpdates.succeeded',
  'agentUpdates.failed',
  'agentUpdates.restartWarning',
  'agentUpdates.restartNotice',
  'agentUpdates.restart',
  'agentUpdates.restarted',
  'agentUpdates.restartError',
  'agentUpdates.loadError',
];

/** Keys whose message MUST carry an interpolation placeholder. */
const PLACEHOLDERS: Record<string, string[]> = {
  'agentUpdates.installed': ['{version}'],
  'agentUpdates.available': ['{version}'],
  'agentUpdates.running': ['{command}'],
  'agentUpdates.succeeded': ['{from}', '{to}'],
  'agentUpdates.failed': ['{error}'],
  'agentUpdates.restartWarning': ['{sessions}'],
  'agentUpdates.restart': ['{alias}'],
};

describe('[#2069] common.agentUpdates i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the card requests`, () => {
      const dict = loadCommon(locale);
      for (const key of KEYS) {
        const value = resolve(dict, key);
        expect(value, `${locale}: ${key}`).toBeTypeOf('string');
        expect((value as string).length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the interpolation placeholders the card passes`, () => {
      // A message that drops `{version}` renders a sentence with a hole in it
      // and nothing fails — next-intl silently ignores an unused param.
      const dict = loadCommon(locale);
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        const value = resolve(dict, key) as string;
        for (const token of tokens) {
          expect(value, `${locale}: ${key}`).toContain(token);
        }
      }
    });
  }

  it('has the same key set in both locales', () => {
    const en = Object.keys((loadCommon('en').agentUpdates ?? {}) as Record<string, unknown>).sort();
    const ja = Object.keys((loadCommon('ja').agentUpdates ?? {}) as Record<string, unknown>).sort();
    expect(ja).toEqual(en);
  });
});
