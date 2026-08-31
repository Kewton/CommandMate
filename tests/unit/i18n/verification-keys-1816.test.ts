/**
 * Real-dictionary i18n guard for the Verification surface (Issue #1816).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key present in `en`
 * and missing from `ja` surfaces the raw key string in production. The
 * component tests here load `en` only (`tests/helpers/real-intl.ts`), so the
 * ja half is covered by nothing but this file.
 *
 * The status labels are the part a grep cannot see: they resolve through
 * `t(\`task.status.${status}\`)` / `t(\`verification.gateStatus.${status}\`)`,
 * so they are enumerated from the same unions the DB layer declares — adding a
 * status to `lib/db` without adding its label fails here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  TASK_STATUSES,
  VERIFICATION_GATE_STATUSES,
  VERIFICATION_RUN_STATUSES,
} from '@/lib/api/verification-api';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8')
  );
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

/** Keys resolved as literals in VerificationPane / VerificationStatusChip. */
const STATIC_KEYS = [
  'activityBar.verification',
  'verification.title',
  'verification.refresh',
  'verification.loading',
  'verification.loadError',
  'verification.contract.heading',
  'verification.contract.empty',
  'verification.contract.scopeAllow',
  'verification.contract.scopeDeny',
  'verification.contract.gates',
  'verification.contract.gatesAll',
  'verification.contract.autoYes',
  'verification.contract.autoYesUnset',
  'verification.contract.file',
  'verification.contract.updated',
  'verification.runs.heading',
  'verification.runs.empty',
  'verification.runs.rerun',
  'verification.runs.rerunPending',
  'verification.runs.rerunConflict',
  'verification.runs.rerunConflictUnknown',
  'verification.runs.rerunError',
  'verification.runs.select',
  'verification.runs.runLabel',
  'verification.runs.trigger',
  'verification.gates.heading',
  'verification.gates.empty',
  'verification.gates.loading',
  'verification.gates.notFound',
  'verification.gates.loadError',
  'verification.gates.exitCode',
  'verification.gates.duration',
  'verification.gates.contractSource',
  'verification.gates.showLog',
  'verification.gates.hideLog',
  'verification.gates.logOmitted',
  'verification.gates.noLog',
  'verification.chip.taskReason',
  'verification.chip.resultBadge',
  'verification.chip.runReason',
  'verification.chip.noRun',
  'verification.chip.failingGates',
  'verification.chip.gatesPassed',
  'verification.chip.openHint',
  'verification.chip.dash',
  // Issue #2064: the contract-less branch's wording, and the touch-reachable
  // reason popover the chip grew when `title=` stopped being the only channel.
  'verification.chip.unverified',
  'verification.chip.noTask',
  'verification.chip.reasonHeading',
  'verification.chip.showReason',
  'verification.chip.hideReason',
];

/** Keys built by string concatenation from a status union. */
const DYNAMIC_KEYS = [
  ...TASK_STATUSES.map((status) => `task.status.${status}`),
  ...VERIFICATION_RUN_STATUSES.map((status) => `verification.runStatus.${status}`),
  ...VERIFICATION_GATE_STATUSES.map((status) => `verification.gateStatus.${status}`),
];

describe('Verification i18n keys (Issue #1816)', () => {
  for (const locale of LOCALES) {
    it(`${locale}/worktree.json resolves every key the pane and the chip use`, () => {
      const dict = load(locale, 'worktree');
      const missing = [...STATIC_KEYS, ...DYNAMIC_KEYS].filter(
        (key) => typeof resolve(dict, key) !== 'string'
      );
      expect(missing).toEqual([]);
    });

    it(`${locale}/schedule.json has the mobile Tools sub-tab label`, () => {
      expect(load(locale, 'schedule').verificationTab).toBeTruthy();
    });
  }

  it('en and ja declare exactly the same verification/task keys', () => {
    const en = load('en', 'worktree');
    const ja = load('ja', 'worktree');
    for (const branch of ['verification', 'task'] as const) {
      const enKeys = leafKeys(en[branch] as Record<string, unknown>).sort();
      const jaKeys = leafKeys(ja[branch] as Record<string, unknown>).sort();
      expect(jaKeys).toEqual(enKeys);
    }
  });

  it('leaves no untranslated placeholder behind (Issue #1703)', () => {
    for (const locale of LOCALES) {
      const dict = load(locale, 'worktree');
      for (const branch of ['verification', 'task'] as const) {
        const sub = dict[branch] as Record<string, unknown>;
        for (const key of leafKeys(sub)) {
          expect(String(resolve(sub, key))).not.toContain('[要レビュー]');
        }
      }
    }
  });

  it('keeps the en RESULT / GATE wording identical to the CLI vocabulary', () => {
    // docs/design/verification-config.md §3.4. The Web UI is a second surface
    // for the same verdicts, so a reader comparing them must not have to
    // translate between two vocabularies.
    const en = load('en', 'worktree');
    expect(resolve(en, 'verification.runStatus.passed')).toBe('passed');
    expect(resolve(en, 'verification.runStatus.failed')).toBe('failed');
    expect(resolve(en, 'verification.runStatus.not_started')).toBe('not_started');
    expect(resolve(en, 'verification.gateStatus.passed')).toBe('PASS');
    expect(resolve(en, 'verification.gateStatus.failed')).toBe('FAIL');
    expect(resolve(en, 'verification.gateStatus.timeout')).toBe('TIMEOUT');
    expect(resolve(en, 'verification.gateStatus.skipped')).toBe('SKIP');
  });
});
