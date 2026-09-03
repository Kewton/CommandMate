/**
 * Unit-level i18n parity test for the file-tab bulk-close keys (Issue #2260).
 *
 * The en/ja key-parity check for the whole `worktree` namespace lives in an
 * integration test that CI does not run on the required `npm run test:unit`
 * gate. This unit test guards the `fileTabs.*` entries added for the bulk-close
 * menu and its unsaved-changes confirmation, so a one-sided locale edit fails
 * the required gate.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

/** Keys added by Issue #2260 on top of the pre-existing fileTabs.* entries. */
const BULK_CLOSE_KEYS = [
  'tabActions',
  'closeAll',
  'closeOthers',
  'closeToRight',
  'confirmCloseTitle',
  'confirmCloseBody',
  'confirmKeepUnsaved',
  'confirmDiscard',
  'confirmCancel',
] as const;

function loadFileTabs(locale: string): Record<string, string> {
  const filePath = path.join(LOCALES_DIR, locale, 'worktree.json');
  const dict = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return (dict.fileTabs ?? {}) as Record<string, string>;
}

describe('file tab bulk-close i18n keys (Issue #2260)', () => {
  it.each(['en', 'ja'])('%s/worktree.json has a non-empty fileTabs.* for every key', (locale) => {
    const fileTabs = loadFileTabs(locale);
    for (const key of BULK_CLOSE_KEYS) {
      expect(fileTabs[key], `${locale}: fileTabs.${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the same set of fileTabs keys (parity)', () => {
    expect(Object.keys(loadFileTabs('en')).sort()).toEqual(
      Object.keys(loadFileTabs('ja')).sort()
    );
  });

  it.each(['en', 'ja'])('%s keeps the {count} placeholder in confirmCloseBody', (locale) => {
    // The dialog interpolates the number of unsaved tabs; dropping the
    // placeholder in one locale would silently render a countless sentence.
    expect(loadFileTabs(locale).confirmCloseBody).toContain('{count}');
  });
});
