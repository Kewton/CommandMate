/**
 * Issue #3056: SECTION_MAP と package.json の files のずれを検出する。
 * 実際の npm pack は実行せず、files と SECTION_MAP を突き合わせる純粋なテスト。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SECTION_MAP } from '../../../../src/cli/utils/docs-reader';

const root = path.resolve(__dirname, '..', '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
  files: string[];
};

function isCovered(file: string): boolean {
  return pkg.files.some((entry) => {
    if (entry.startsWith('!')) return false;
    return entry.endsWith('/') ? file.startsWith(entry) : file === entry;
  });
}

describe('SECTION_MAP and package.json files', () => {
  const entries = Object.entries(SECTION_MAP);

  it.each(entries)('section %s (%s) is covered by files', (_name, file) => {
    // README.md は npm が必ず同梱する
    if (file === 'README.md') return;
    expect(isCovered(file)).toBe(true);
  });

  it.each(entries)('section %s (%s) exists on disk', (_name, file) => {
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  it('points at English docs', () => {
    for (const [, file] of entries) {
      if (file === 'README.md') continue;
      expect(file.startsWith('docs/en/')).toBe(true);
    }
  });

  it('does not ship the whole docs/ directory', () => {
    expect(pkg.files).not.toContain('docs/');
    expect(pkg.files).not.toContain('docs');
  });
});
