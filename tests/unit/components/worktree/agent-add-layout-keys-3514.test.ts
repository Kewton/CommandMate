/**
 * Issue #3514: real-dictionary guard for the strings this Issue requests.
 *
 * The global next-intl mock echoes keys back, so the component tests stay green
 * with every key missing; in production a missing key renders as its literal
 * path — as the only name of an icon-only layout button.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../../locales');

function load(locale: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

const KEYS: Record<string, Record<string, string[]>> = {
  terminal: {
    layoutGroupLabel: [],
    layoutSplits: ['count'],
    composerTarget: ['{agent}', '{branch}'],
    composerTargetNoBranch: ['{agent}'],
    composerTargetLabel: ['{agent}', '{branch}'],
    composerTargetLabelNoBranch: ['{agent}'],
    moreActions: [],
    searchTerminal: [],
    endSession: [],
  },
  surfaceMode: { terminal: [], chat: [] },
  agentAdd: {
    button: [],
    title: [],
    tool: [],
    notInstalled: ['{name}'],
    installedUnknown: [],
    noInstalled: [],
    name: [],
    namePlaceholder: [],
    placement: [],
    placementNewSplit: [],
    placementReplace: [],
    placementRosterOnly: [],
    placementNewSplitFull: ['{max}'],
    startHint: [],
    submit: [],
    cancel: [],
    saveError: [],
    maxReached: ['{max}'],
  },
};

describe('[#3514] worktree i18n keys', () => {
  for (const locale of ['en', 'ja']) {
    it(`${locale} defines every key with its placeholders`, () => {
      const dict = load(locale);
      for (const [section, keys] of Object.entries(KEYS)) {
        for (const [key, tokens] of Object.entries(keys)) {
          const value = dict[section]?.[key];
          expect(value, `${locale}: ${section}.${key}`).toBeTypeOf('string');
          expect(String(value).trim().length, `${locale}: ${section}.${key}`).toBeGreaterThan(0);
          for (const token of tokens) {
            expect(String(value), `${locale}: ${section}.${key} ${token}`).toContain(token);
          }
        }
      }
    });

    it(`${locale} drops the stepper's add / remove split labels`, () => {
      const terminal = load(locale).terminal;
      expect(terminal.addSplit).toBeUndefined();
      expect(terminal.removeSplit).toBeUndefined();
    });
  }
});
