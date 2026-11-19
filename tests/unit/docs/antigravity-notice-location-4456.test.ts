/**
 * Issue #4456 item 2: where the CLI keeps `antigravity-notice.json`.
 *
 * The implementation (`src/cli/utils/antigravity-notice.ts`, `defaultRecordDir`)
 * writes it to `~/.commandmate` for a global install and to the CLI package's
 * root for a local run — never the cwd. The web app guide (ja / en), which
 * describes the notice, says so now; the code is pinned beside it so the two
 * cannot drift apart unnoticed.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliPackageRoot, defaultRecordDir } from '../../../src/cli/utils/antigravity-notice';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** The Antigravity bullet of a guide (the paragraph naming the CLI's notice). */
function noticeBullet(relative: string, marker: RegExp): string {
  const line = read(relative).split('\n').find((l) => marker.test(l));
  expect(line, `${relative}: the Antigravity notice bullet`).toBeDefined();
  return line as string;
}

describe('[#4456] the record location the code uses', () => {
  it('global: ~/.commandmate; local: the CLI package root, which is not the cwd (4456)', () => {
    expect(defaultRecordDir(true)).toBe(path.join(os.homedir(), '.commandmate'));
    expect(defaultRecordDir(false)).toBe(cliPackageRoot());
    expect(fs.existsSync(path.join(cliPackageRoot(), 'package.json'))).toBe(true);
  });
});

describe('[#4456] the web app guide says the same (ja / en)', () => {
  it('ja: names the file, ~/.commandmate for a global install and the package root for a local run (4456)', () => {
    const bullet = noticeBullet('docs/user-guide/webapp-guide.md', /Antigravity を選ぶと、利用上の注意/);
    expect(bullet).toContain('antigravity-notice.json');
    expect(bullet).toContain('`~/.commandmate`');
    expect(bullet).toMatch(/グローバル install/);
    expect(bullet).toMatch(/ローカル実行[^。]*CLI のパッケージの根/);
    expect(bullet).not.toMatch(/設定ディレクトリ/);
  });

  it('en: names the file, ~/.commandmate for a global install and the package root for a local run (4456)', () => {
    const bullet = noticeBullet('docs/en/user-guide/webapp-guide.md', /Choosing Antigravity shows a usage notice/);
    expect(bullet).toContain('antigravity-notice.json');
    expect(bullet).toContain('`~/.commandmate`');
    expect(bullet).toMatch(/global install/);
    expect(bullet).toMatch(/CLI package's root for a local run/);
    expect(bullet).not.toMatch(/config directory/);
  });
});
