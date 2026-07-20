/**
 * Real-dictionary i18n guard for the `skills` namespace (Issue #1232)
 *
 * The next-intl mock echoes `skills.<key>`, so every component test here would
 * still pass against a dictionary that never defined the key. Only asserting
 * against the shipped JSON proves the screens render prose rather than key
 * paths — `src/i18n.ts` has no message fallback, so a missing key reaches the
 * user verbatim.
 *
 * Call-site keys are extracted from the source rather than listed by hand, so
 * adding a `t('…')` without a dictionary entry fails here immediately.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  COMPATIBILITY_LABEL_KEY,
  RECOMMENDATION_LABEL_KEY,
  RISK_LABEL_KEY,
  catalogReasonLabelKey,
  resolveSkillMessageKey,
} from '@/components/skills/skill-vocabulary';
import { AGENT_SUPPORT_LABEL_KEYS, PERMISSION_DECLARATION_NOTICE_KEY } from '@/lib/skills/constants';
import { SKILL_COMPATIBILITY_MESSAGE_KEYS } from '@/lib/skills/compatibility';

const ROOT = path.resolve(__dirname, '../../../..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const SOURCE_DIRS = [
  path.join(ROOT, 'src/components/skills'),
  path.join(ROOT, 'src/app/skills'),
];

function loadSkills(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'skills.json'), 'utf-8'));
}

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

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Literal `t('key')` arguments used by the Skill screens. */
function callSiteKeys(): string[] {
  const keys = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const match of content.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) {
        keys.add(match[1]);
      }
    }
  }
  return [...keys].sort();
}

/**
 * Keys supplied by the `lib/skills` contract rather than written at a call
 * site. `src/lib/skills` publishes them namespace-qualified so UI and CLI share
 * one vocabulary; the screens strip the prefix before resolving them.
 */
function contractKeys(): string[] {
  return [
    ...Object.values(SKILL_COMPATIBILITY_MESSAGE_KEYS),
    ...Object.values(AGENT_SUPPORT_LABEL_KEYS),
    PERMISSION_DECLARATION_NOTICE_KEY,
  ]
    .map(resolveSkillMessageKey)
    .concat(Object.values(RECOMMENDATION_LABEL_KEY))
    .concat(Object.values(COMPATIBILITY_LABEL_KEY))
    .concat(Object.values(RISK_LABEL_KEY))
    .concat(
      [
        'SKILL_CATALOG_FETCH_FAILED',
        'SKILL_CATALOG_RATE_LIMITED',
        'SKILL_CATALOG_OVERSIZED',
        'SKILL_CATALOG_MALFORMED',
        'SKILL_CATALOG_INVALID_SCHEMA',
        null,
      ].map(catalogReasonLabelKey)
    )
    .sort();
}

/**
 * Interpolated messages: a dropped placeholder renders the literal `{range}`
 * to the user, which no key-parity check would catch.
 */
const PLACEHOLDERS: Record<string, string[]> = {
  'search.resultCount': ['{shown}', '{total}'],
  'compatibility.requiredRange': ['{range}'],
  'compatibility.currentVersion': ['{version}'],
  'compatibility.reason.satisfied': ['{range}', '{currentVersion}'],
  'compatibility.reason.hostVersionOutOfRange': ['{range}', '{currentVersion}'],
  'compatibility.reason.hostVersionUnknown': ['{range}'],
  'compatibility.reason.rangeUnsupported': ['{range}'],
  'risk.declaredLabel': ['{level}'],
  'detail.packageBytes': ['{bytes}'],
  'detail.install.blockedIncompatible': ['{reason}'],
  'card.provider': ['{provider}'],
  'state.errorCode': ['{code}'],
  'catalog.fetchedAt': ['{timestamp}'],
  'catalog.revalidatedAt': ['{timestamp}'],
  'catalog.sourceLabel': ['{repository}', '{ref}'],
};

/**
 * Labels that are the same string in both locales on purpose: they name a
 * format or identifier, not a concept, and localizing them would misdescribe
 * what the adjacent value literally is.
 */
const UNTRANSLATED_BY_DESIGN = ['detail.skillId', 'detail.sourceRef', 'detail.packageDigest'];

describe('skills i18n keys (Issue #1232)', () => {
  it.each(['en', 'ja'])('%s/skills.json has non-empty values for every leaf', (locale) => {
    const dict = loadSkills(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolve(dict, key), `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    expect(leafKeys(loadSkills('en')).sort()).toEqual(leafKeys(loadSkills('ja')).sort());
  });

  it('finds the call sites it is meant to guard', () => {
    expect(callSiteKeys().length).toBeGreaterThan(20);
  });

  it.each(['en', 'ja'])('%s defines every key the Skill screens resolve', (locale) => {
    const dict = loadSkills(locale);
    for (const key of [...callSiteKeys(), ...contractKeys()]) {
      expect(resolve(dict, key), `${locale} missing ${key}`).toEqual(expect.any(String));
    }
  });

  it('ships no dictionary entry the screens never resolve', () => {
    const used = new Set([...callSiteKeys(), ...contractKeys()]);
    const unused = leafKeys(loadSkills('en')).filter((key) => !used.has(key));
    expect(unused).toEqual([]);
  });

  it('translates the Japanese dictionary rather than leaving it in English', () => {
    const en = loadSkills('en');
    const ja = loadSkills('ja');
    const untranslated = leafKeys(en)
      .filter((key) => !UNTRANSLATED_BY_DESIGN.includes(key))
      .filter((key) => resolve(en, key) === resolve(ja, key));
    expect(untranslated).toEqual([]);
  });

  it('keeps interpolation placeholders intact in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadSkills(locale);
      for (const [key, placeholders] of Object.entries(PLACEHOLDERS)) {
        const value = resolve(dict, key) as string;
        for (const placeholder of placeholders) {
          expect(value, `${locale}: ${key} lost ${placeholder}`).toContain(placeholder);
        }
      }
    }
  });

  it('gives the three compatibility verdicts distinct labels in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadSkills(locale);
      const labels = ['compatible', 'incompatible', 'unknown'].map((status) =>
        resolve(dict, `compatibility.status.${status}`)
      );
      expect(new Set(labels).size, `${locale}: two verdicts share a label`).toBe(3);
    }
  });

  it('gives the three risk levels distinct labels in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const dict = loadSkills(locale);
      const labels = ['low', 'moderate', 'high'].map((level) =>
        resolve(dict, `risk.level.${level}`)
      );
      expect(new Set(labels).size, `${locale}: two risk levels share a label`).toBe(3);
    }
  });

  it('defines the shared Skills navigation label in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const common = JSON.parse(
        fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf-8')
      );
      expect(resolve(common, 'nav.skills'), `${locale} missing nav.skills`).toEqual(
        expect.any(String)
      );
    }
  });
});
