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
  // Issue #2062: the CLI exit-code table, the built-in gate descriptions, the
  // meaning of the `[contract]` marker, and the reason a gate did not run.
  'verification.runs.cliLegend',
  'verification.runs.cliLegendItem',
  'verification.runs.exitCode',
  'verification.gates.verdictHeading',
  'verification.gates.contractSourceHint',
  'verification.gates.builtinBadge',
  'verification.gates.skipHeading',
  'verification.gates.skipReasonFor',
  'verification.onboarding.configured.builtinHint',
];

/** Keys built by string concatenation from a status union. */
const DYNAMIC_KEYS = [
  ...TASK_STATUSES.map((status) => `task.status.${status}`),
  ...VERIFICATION_RUN_STATUSES.map((status) => `verification.runStatus.${status}`),
  ...VERIFICATION_GATE_STATUSES.map((status) => `verification.gateStatus.${status}`),
  // Issue #2062: every badge has a one-line gloss resolved the same way.
  ...VERIFICATION_RUN_STATUSES.map((status) => `verification.runStatusGloss.${status}`),
  ...VERIFICATION_GATE_STATUSES.map((status) => `verification.gateStatusGloss.${status}`),
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

  it('ties the verdicts to the CLI by exit code rather than by repeating its tokens', () => {
    // Superseded by Issue #2062. This assertion used to pin the en badges to
    // the CLI's own tokens (`passed`, `PASS`, `not_started`) so a reader
    // comparing the two surfaces would not have to translate between two
    // vocabularies. It cited docs/design/verification-config.md §3.4, which
    // governs the CLI's *stdout* — `RESULT failed`, `GATE <id> SKIP` — and says
    // nothing about the Web UI. That output is unchanged and still pinned by
    // `tests/unit/cli/commands/verify.test.ts`; only the badges moved.
    //
    // What it actually produced was an untranslated screen in BOTH locales: ja
    // inherited the same tokens verbatim, and neither language said what any of
    // them meant. The correspondence is now stated explicitly instead of
    // implied by spelling — the runs section prints the CLI's exit-code table
    // (`verification.runs.cliLegend`) and every run row carries its own
    // `exit=` — so the badges are free to be words. The raw-token ban is
    // enforced in `verification-vocabulary-2062.test.ts`; what is checked here
    // is that the correspondence did not go missing with the tokens.
    for (const locale of LOCALES) {
      const dict = load(locale, 'worktree');
      expect(resolve(dict, 'verification.runs.cliLegend')).toContain('{items}');
      expect(resolve(dict, 'verification.runs.cliLegendItem')).toContain('exit {code}');
      expect(resolve(dict, 'verification.runs.exitCode')).toContain('{code}');
    }
  });
});
