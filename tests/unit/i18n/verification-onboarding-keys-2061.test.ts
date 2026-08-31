/**
 * Real-dictionary i18n guard for the Verification onboarding block (Issue #2061).
 *
 * A separate file from `verification-keys-1816.test.ts` on purpose: #2062 (the
 * Verification vocabulary translation) and #2063 (gate selection / cancel) are
 * in flight against the same dictionary, and three Issues editing one key list
 * is three conflicts in the same hunk.
 *
 * `src/i18n.ts` declares no `onError` / `getMessageFallback`, so a key present
 * in `en` and missing from `ja` renders as the raw key string in production.
 * The component tests load `en` only, so the `ja` half is covered by nothing but
 * this file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8')
  );
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Every key VerificationPane's onboarding block resolves as a literal. */
const ONBOARDING_KEYS = [
  'verification.onboarding.what',
  'verification.onboarding.how',
  'verification.onboarding.loading',
  'verification.onboarding.configError',
  'verification.onboarding.invalid',
  'verification.onboarding.noConfig.body',
  'verification.onboarding.noConfig.hint',
  'verification.onboarding.noConfig.action',
  'verification.onboarding.noConfig.pending',
  'verification.onboarding.noConfig.docs',
  'verification.onboarding.noConfig.created',
  'verification.onboarding.noConfig.conflict',
  'verification.onboarding.noConfig.empty',
  'verification.onboarding.noConfig.error',
  'verification.onboarding.configured.body',
  'verification.onboarding.configured.gatesHeading',
  'verification.onboarding.configured.builtin',
  // Issue #2062: the built-in gates are listed by id here, which says nothing
  // about what they are. This line points at the gate rows that now describe
  // them, so the list is not the reader's only encounter with the four ids.
  'verification.onboarding.configured.builtinHint',
  'verification.onboarding.configured.action',
  'verification.onboarding.running.progress',
  'verification.onboarding.running.elapsed',
  'verification.onboarding.running.action',
  'verification.onboarding.running.hint',
  'verification.onboarding.result.body',
  'verification.onboarding.result.action',
];

/** Interpolation parameters the pane passes, per key. */
const PLACEHOLDERS: Record<string, string[]> = {
  'verification.onboarding.what': ['path'],
  'verification.onboarding.invalid': ['path', 'message'],
  'verification.onboarding.configError': ['message'],
  'verification.onboarding.noConfig.body': ['path'],
  'verification.onboarding.noConfig.created': ['path', 'count'],
  'verification.onboarding.noConfig.conflict': ['path'],
  'verification.onboarding.noConfig.empty': ['path'],
  'verification.onboarding.noConfig.error': ['message'],
  'verification.onboarding.configured.body': ['path', 'count'],
  'verification.onboarding.configured.builtin': ['gates'],
  'verification.onboarding.running.progress': ['done', 'total'],
  'verification.onboarding.running.elapsed': ['elapsed'],
  'verification.onboarding.result.body': ['runId', 'verdict'],
  'verification.runs.empty': ['worktreeId'],
};

describe('Verification onboarding i18n keys (Issue #2061)', () => {
  for (const locale of LOCALES) {
    it(`${locale}/worktree.json resolves every onboarding key`, () => {
      const dict = load(locale);
      const missing = ONBOARDING_KEYS.filter((key) => typeof resolve(dict, key) !== 'string');
      expect(missing).toEqual([]);
    });

    it(`${locale} carries every interpolation parameter the pane passes`, () => {
      // next-intl renders an unknown placeholder as the literal `{name}`, and a
      // *missing* one silently drops the value — which is how a translated
      // string ends up saying "gates are declared in ." with no path.
      const dict = load(locale);
      for (const [key, params] of Object.entries(PLACEHOLDERS)) {
        const value = String(resolve(dict, key));
        for (const param of params) {
          expect(value, `${locale}: ${key} is missing {${param}}`).toContain(`{${param}}`);
        }
      }
    });
  }

  it('interpolates the worktree id into the empty-run CTA (Issue #2061 item 4)', () => {
    // It used to print the literal `<worktree-id>`, so the CLI hint could not be
    // copied without editing it first.
    for (const locale of LOCALES) {
      const empty = String(resolve(load(locale), 'verification.runs.empty'));
      expect(empty).not.toContain('<worktree-id>');
      expect(empty).toContain('commandmate verify {worktreeId}');
    }
  });

  it('names `commandmate verify init` in both locales', () => {
    // The Web button and the CLI command are one implementation; the hint is
    // what makes the CLI half reachable from the screen.
    for (const locale of LOCALES) {
      expect(String(resolve(load(locale), 'verification.onboarding.noConfig.hint'))).toContain(
        'commandmate verify init'
      );
    }
  });

  it('declares exactly the same onboarding keys in en and ja', () => {
    const leaves = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value && typeof value === 'object' && !Array.isArray(value)
          ? leaves(value as Record<string, unknown>, full)
          : [full];
      });

    const en = resolve(load('en'), 'verification.onboarding') as Record<string, unknown>;
    const ja = resolve(load('ja'), 'verification.onboarding') as Record<string, unknown>;
    expect(leaves(ja).sort()).toEqual(leaves(en).sort());
    // Every key the pane uses is declared, and nothing else is.
    expect(leaves(en).map((key) => `verification.onboarding.${key}`).sort()).toEqual(
      [...ONBOARDING_KEYS].sort()
    );
  });

  it('still reads the #2062-owned vocabulary through the same keys', () => {
    // `verification.runStatus.*` / `verification.gateStatus.*` were Issue
    // #2062's to translate, and it has: the values are now words, in each
    // language, and the raw tokens they replaced are banned by
    // `verification-vocabulary-2062.test.ts`. This assertion used to pin those
    // values so #2061 could not move them; what it guards now is that the
    // onboarding block's result line — which prints the run verdict through
    // exactly these keys — still has keys to read.
    for (const locale of ['en', 'ja'] as const) {
      const dict = load(locale);
      for (const key of [
        'verification.runStatus.passed',
        'verification.runStatus.failed',
        'verification.gateStatus.passed',
      ]) {
        expect(typeof resolve(dict, key)).toBe('string');
      }
    }
  });
});
