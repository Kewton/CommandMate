/**
 * Real-dictionary i18n guard for the panel toggles (Issue #2259).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so every component test here stays green with the dictionaries empty, and
 * `src/i18n.ts` has no `onError` / `getMessageFallback` — a missing key ships
 * as the literal `terminal.filesEmptyHint` in a tooltip. This file is what
 * stands between those two facts.
 *
 * It also pins the DISTINCTION the Issue exists for: the Activity Bar's `files`
 * activity opens the file TREE, while the Action bar's `terminal.filesLabel`
 * names the panel of files you have opened. Both said just "Files" / 「ファイル」
 * before, which is why one of the two "Files" buttons looked broken. Asserting
 * they differ is the only automated way that stays true after a re-translation.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function worktreeDict(locale: string): Record<string, Record<string, unknown>> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
}

/** Every `terminal.*` key the Action bar toggles request at runtime. */
const TERMINAL_KEYS = [
  'historyLabel',
  'filesLabel',
  'showHistory',
  'hideHistory',
  'showFiles',
  'hideFiles',
  // Issue #2259 additions: the tooltips that explain a disabled toggle and the
  // scope of the History switch.
  'historyAllSplitsHint',
  'historyChatOnlyHint',
  'filesEmptyHint',
];

describe('[#2259] worktree panel-toggle i18n', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every terminal key the Action bar requests`, () => {
      const terminal = worktreeDict(locale).terminal;
      expect(terminal, `${locale}: worktree.terminal`).toBeTypeOf('object');
      for (const key of TERMINAL_KEYS) {
        const value = terminal?.[key];
        expect(value, `${locale}: terminal.${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${locale}: terminal.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} names the file TREE and the OPEN FILES panel differently`, () => {
      const dict = worktreeDict(locale);
      const tree = dict.activityBar?.files;
      const openFiles = dict.terminal?.filesLabel;
      expect(tree, `${locale}: activityBar.files`).toBeTypeOf('string');
      expect(openFiles, `${locale}: terminal.filesLabel`).toBeTypeOf('string');
      expect(String(tree)).not.toBe(String(openFiles));
    });

    it(`${locale} keeps the Activity Bar label a "tree" and the header label an "open files"`, () => {
      const dict = worktreeDict(locale);
      const tree = String(dict.activityBar?.files);
      const openFiles = String(dict.terminal?.filesLabel);
      const treeWord = locale === 'ja' ? 'ツリー' : 'Tree';
      const openWord = locale === 'ja' ? '開いている' : 'Open';
      expect(tree, `${locale}: activityBar.files`).toContain(treeWord);
      expect(openFiles, `${locale}: terminal.filesLabel`).toContain(openWord);
    });
  }
});
