/**
 * No `verification.*` value is still a raw status token (Issue #2062).
 *
 * ## What was wrong
 *
 * `verification.runStatus.*` and `verification.gateStatus.*` were the database
 * tokens — `passed`, `not_started`, `SKIP`, `TIMEOUT` — and `locales/ja` held
 * exactly the same strings as `locales/en`. The screen was therefore
 * untranslated in Japanese while looking translated, and in *either* language a
 * reader had no way to learn that `not_started` means "there is no work here to
 * judge" rather than "this has not been run yet".
 *
 * ## The two things pinned here
 *
 * 1. **No raw token survives as a display value.** Enumerated from the same
 *    status unions the DB layer declares, so a status added later starts out
 *    failing rather than quietly rendering its own id.
 * 2. **ja and en differ.** Identical values are how the raw tokens hid: both
 *    locales resolved, both looked deliberate, and neither was translated. This
 *    covers the glosses too, which is where the actual explanation now lives.
 *
 * Both checks run over the WHOLE `verification.*` subtree, not just the four
 * status branches. Scoping them to the branches that happened to be broken
 * leaves the same defect free to reappear one key over: an en
 * `verification.gates.someLabel: "not_started"` with a ja translation beside it
 * satisfies a branch-scoped token ban and a ja/en difference check at the same
 * time, and is exactly the bug this Issue fixed.
 *
 * The literal config identifiers the pane prints on purpose (`scope.allow`,
 * `verify.gates`, `[contract]`, …) are exempt by name below — those are field
 * names in a YAML file, and translating them would be a lie about what to type.
 * Every waiver is asserted to be LIVE, so one that stops applying fails here
 * rather than sitting in the list forever granting nothing.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  TASK_STATUSES,
  VERIFICATION_GATE_STATUSES,
  VERIFICATION_RUN_STATUSES,
} from '@/lib/api/verification-api';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
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

/**
 * Keys whose value is deliberately the same in both locales: a YAML field name,
 * a CLI marker, or punctuation. Each one is a string the operator would type or
 * grep for, so a translation would make it wrong.
 */
const IDENTICAL_BY_DESIGN = new Set([
  'contract.scopeAllow',
  'contract.scopeDeny',
  'contract.gates',
  'contract.autoYes',
  'gates.exitCode',
  'gates.duration',
  'gates.contractSource',
  // Pure interpolation — a gate id, a colon and the reason. No words to translate.
  'gates.skipReasonFor',
  'runs.runLabel',
  'runs.trigger',
  'runs.cliLegendItem',
  'chip.resultBadge',
  'chip.dash',
]);

/**
 * Values that have the shape of a bare identifier but are ordinary words of the
 * locale they are written in, keyed by that locale.
 *
 * Two entries, both English: `updated` is a field label in the contract
 * summary, `built-in` is the marker beside a built-in gate's id. Neither is a
 * status token, and neither has a ja counterpart that looks like one.
 */
const NOT_A_TOKEN: Readonly<Record<string, readonly string[]>> = {
  en: ['contract.updated', 'gates.builtinBadge'],
  ja: [],
};

/**
 * Every spelling of a status id that would count as "still the raw token":
 * the id itself, its upper case, and the CLI's own short gate label.
 */
const CLI_GATE_LABELS: Record<string, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  timeout: 'TIMEOUT',
  skipped: 'SKIP',
  error: 'ERROR',
  running: 'RUNNING',
};

/**
 * Every status id the product can render, in every spelling that would count as
 * leaking one into a label. Enumerated from the unions the DB layer declares —
 * including `task.status.*`, because a task token pasted into a verification
 * label is the same defect wearing a different name.
 */
const STATUS_TOKENS: ReadonlySet<string> = new Set(
  [...TASK_STATUSES, ...VERIFICATION_RUN_STATUSES, ...VERIFICATION_GATE_STATUSES].flatMap(
    (status) => [
      status,
      status.toUpperCase(),
      ...(CLI_GATE_LABELS[status] ? [CLI_GATE_LABELS[status]] : []),
    ]
  )
);

/** A value that is nothing but a lowercase / uppercase identifier. */
const BARE_IDENTIFIER = /^([a-z][a-z0-9_-]*|[A-Z][A-Z0-9_]*)$/;

/**
 * The status branches whose values are rendered as a badge. These are the ones
 * that carried a raw token.
 */
const STATUS_BRANCHES = [
  { branch: 'runStatus', statuses: VERIFICATION_RUN_STATUSES },
  { branch: 'gateStatus', statuses: VERIFICATION_GATE_STATUSES },
  { branch: 'runStatusGloss', statuses: VERIFICATION_RUN_STATUSES },
  { branch: 'gateStatusGloss', statuses: VERIFICATION_GATE_STATUSES },
] as const;

function rawFormsOf(status: string): string[] {
  return [status, status.toUpperCase(), CLI_GATE_LABELS[status]].filter(
    (form): form is string => typeof form === 'string'
  );
}

describe('Verification vocabulary is translated (Issue #2062)', () => {
  for (const locale of LOCALES) {
    it(`${locale} declares a label and a gloss for every run and gate status`, () => {
      const dict = load(locale);
      const missing: string[] = [];
      for (const { branch, statuses } of STATUS_BRANCHES) {
        for (const status of statuses) {
          const value = resolve(dict, `verification.${branch}.${status}`);
          if (typeof value !== 'string' || value.trim() === '') {
            missing.push(`verification.${branch}.${status}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it(`${locale} renders no status as its raw token`, () => {
      const dict = load(locale);
      const raw: string[] = [];
      for (const { branch, statuses } of STATUS_BRANCHES) {
        for (const status of statuses) {
          const key = `verification.${branch}.${status}`;
          const value = String(resolve(dict, key));
          if (rawFormsOf(status).includes(value)) raw.push(`${key} = ${value}`);
        }
      }
      expect(raw).toEqual([]);
    });
  }

  for (const locale of LOCALES) {
    it(`${locale} renders no status token anywhere under verification.*`, () => {
      // The subtree-wide half of the ban. Branch-scoped checks let the same
      // defect reappear one key over: an en `gates.someLabel: "not_started"`
      // with a ja translation beside it passes both a runStatus-only token ban
      // and a ja/en difference check.
      const sub = load(locale).verification as Record<string, unknown>;
      const leaked = leafKeys(sub).filter((key) => STATUS_TOKENS.has(String(resolve(sub, key))));
      expect(leaked).toEqual([]);
    });

    it(`${locale} renders no bare identifier under verification.* outside the waivers`, () => {
      const sub = load(locale).verification as Record<string, unknown>;
      const waived = new Set(NOT_A_TOKEN[locale] ?? []);
      const bare = leafKeys(sub)
        .filter((key) => !waived.has(key))
        .filter((key) => BARE_IDENTIFIER.test(String(resolve(sub, key))));
      expect(bare).toEqual([]);
    });

    it(`${locale}'s bare-identifier waivers are all still live`, () => {
      const sub = load(locale).verification as Record<string, unknown>;
      const dead = (NOT_A_TOKEN[locale] ?? []).filter(
        (key) => !BARE_IDENTIFIER.test(String(resolve(sub, key)))
      );
      expect(dead).toEqual([]);
    });
  }

  it('says something different in ja than in en for every verification string', () => {
    const en = load('en').verification as Record<string, unknown>;
    const ja = load('ja').verification as Record<string, unknown>;
    const identical = leafKeys(en)
      .filter((key) => !IDENTICAL_BY_DESIGN.has(key))
      .filter((key) => String(resolve(ja, key)) === String(resolve(en, key)));
    expect(identical).toEqual([]);
  });

  it('grants no ja/en waiver that is not actually needed', () => {
    // A waiver that stops applying is a hole nobody notices: it sits in the
    // list granting permission for a key that no longer needs it, and the next
    // reader takes the list as the record of what is deliberate.
    // `runs.exitCode` was one of these on the first pass — waived, never
    // identical, and removed by this assertion.
    const en = load('en').verification as Record<string, unknown>;
    const ja = load('ja').verification as Record<string, unknown>;
    const unnecessary = [...IDENTICAL_BY_DESIGN].filter(
      (key) => String(resolve(ja, key)) !== String(resolve(en, key))
    );
    expect(unnecessary).toEqual([]);
  });

  it('keeps `cancelled` translated for the cancel API #2063 will add', () => {
    // Dead code today — nothing produces a cancelled run yet — and deliberately
    // NOT deleted: #2063 introduces the cancel endpoint that reaches it, and a
    // key removed now is a raw token rendered then.
    for (const locale of LOCALES) {
      const dict = load(locale);
      expect(String(resolve(dict, 'verification.runStatus.cancelled'))).not.toBe('cancelled');
      expect(String(resolve(dict, 'verification.runStatusGloss.cancelled'))).not.toBe('');
    }
  });

  it('describes each of the four built-in gates in both locales', () => {
    for (const locale of LOCALES) {
      const dict = load(locale);
      for (const key of ['workEvidence', 'scope', 'envClean', 'config']) {
        expect(typeof resolve(dict, `verification.gates.builtin.${key}`)).toBe('string');
      }
    }
  });

  it('explains every skip reason the classifier can return', () => {
    for (const locale of LOCALES) {
      const dict = load(locale);
      for (const key of [
        'primaryCheckout',
        'workEvidence',
        'mutex',
        'detachedContract',
        'noContract',
        'notRequired',
        'unknown',
      ]) {
        expect(typeof resolve(dict, `verification.gates.skipReason.${key}`)).toBe('string');
      }
    }
  });

  it('states what the [contract] marker means', () => {
    for (const locale of LOCALES) {
      expect(String(resolve(load(locale), 'verification.gates.contractSourceHint'))).toContain(
        '[contract]'
      );
    }
  });
});
