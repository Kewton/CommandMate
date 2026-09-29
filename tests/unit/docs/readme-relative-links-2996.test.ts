/**
 * Relative links in the READMEs point at files that exist (#2996).
 *
 * `docs/ja/README.md` lives one directory below `docs/`, so a link written as
 * `user-guide/webapp-guide.md` resolves to `docs/ja/user-guide/...`, which does
 * not exist. Nothing else in this suite resolves README links, so such a link
 * stays broken until someone clicks it. This pins every relative link in both
 * READMEs to an existing file, resolved from the README's own directory.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const READMES: ReadonlyArray<string> = ['README.md', 'docs/ja/README.md'];

/** `](<target>)` with an optional `"title"`; angle-bracketed targets are allowed. */
const LINK_PATTERN = /\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

/** Returns the relative link targets in `file` that do not resolve to an existing path. */
function findBrokenRelativeLinks(file: string): string[] {
  const content = fs.readFileSync(file, 'utf8');
  const baseDir = path.dirname(file);
  const broken: string[] = [];
  for (const match of content.matchAll(LINK_PATTERN)) {
    const target = match[1] ?? match[2];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const withoutAnchor = target.split('#')[0];
    if (withoutAnchor === '') continue;
    const resolved = path.resolve(baseDir, decodeURIComponent(withoutAnchor));
    if (!fs.existsSync(resolved)) broken.push(target);
  }
  return broken;
}

describe('README relative links resolve from the README location (#2996)', () => {
  it.each(READMES)('%s has no broken relative links', (readme) => {
    expect(findBrokenRelativeLinks(path.join(REPO_ROOT, readme))).toEqual([]);
  });

  it('docs/ja/README.md links the push notification section via ../user-guide/', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, 'docs/ja/README.md'), 'utf8');
    expect(content).toContain('](../user-guide/webapp-guide.md#スマホ通知プッシュ通知)');
    const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs/user-guide/webapp-guide.md'), 'utf8');
    expect(guide).toMatch(/^## スマホ通知（プッシュ通知）$/m);
  });

  describe('controls', () => {
    let tmpDir: string | undefined;

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    function writeFixture(body: string): string {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-links-2996-'));
      fs.mkdirSync(path.join(tmpDir, 'docs/ja'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs/user-guide'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs/user-guide/webapp-guide.md'), '# guide\n');
      const readme = path.join(tmpDir, 'docs/ja/README.md');
      fs.writeFileSync(readme, body);
      return readme;
    }

    it('flags a link that only resolves from the wrong directory (positive control)', () => {
      const readme = writeFixture('[通知](user-guide/webapp-guide.md#スマホ通知プッシュ通知)\n');
      expect(findBrokenRelativeLinks(readme)).toEqual([
        'user-guide/webapp-guide.md#スマホ通知プッシュ通知',
      ]);
    });

    it('accepts correct relative links and skips external / anchor-only links (negative control)', () => {
      const readme = writeFixture(
        [
          '[通知](../user-guide/webapp-guide.md#スマホ通知プッシュ通知)',
          '[ext](https://example.com/missing.md)',
          '[mail](mailto:someone@example.com)',
          '[top](#top)',
        ].join('\n'),
      );
      expect(findBrokenRelativeLinks(readme)).toEqual([]);
    });
  });
});
