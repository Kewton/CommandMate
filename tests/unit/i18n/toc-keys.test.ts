/**
 * Unit-level i18n parity test for the markdown TOC keys (Issue #1007).
 *
 * The en/ja key-parity check for the whole `worktree` namespace lives in an
 * integration test that CI does not run on the required `npm run test:unit`
 * gate. This unit test guards the specific `toc.*` keys added for the file
 * viewer TOC so a one-sided locale edit fails the required gate.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const TOC_KEYS = ['title', 'show', 'hide', 'empty'] as const;

function loadWorktree(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'worktree.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('markdown TOC i18n keys (Issue #1007)', () => {
  it.each(['en', 'ja'])('%s/worktree.json has a non-empty toc.* for every key', (locale) => {
    const toc = loadWorktree(locale).toc as Record<string, string> | undefined;
    expect(toc).toBeDefined();
    for (const key of TOC_KEYS) {
      expect(toc?.[key]).toBeTruthy();
    }
  });

  it('en and ja expose the same set of toc keys (parity)', () => {
    const en = (loadWorktree('en').toc ?? {}) as Record<string, string>;
    const ja = (loadWorktree('ja').toc ?? {}) as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});
