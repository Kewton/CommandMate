/**
 * Tests for the published package's `files` whitelist (Issue #1315).
 *
 * `files` whitelists `.next/`, which pulled in `.next/cache` — Next.js's webpack
 * build cache, needed only to make the *next* build faster and never read at
 * runtime. It was 633MB of a 656MB package, so every `npx commandmate@latest`
 * unpacked it: measured 656.3MB unpacked / 89.8MB downloaded before, 22.8MB /
 * 5.3MB after. `.npmignore` cannot fix this — a `files` whitelist wins over it,
 * so the exclusion has to live here.
 *
 * Nothing else guards this. `npm pack` is only exercised on release, so a
 * regression would ship silently and only show up as a slow install.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const files: string[] = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
).files;

describe('Issue #1315: the published package excludes the Next.js build cache', () => {
  it('negates .next/cache', () => {
    expect(files).toContain('!.next/cache');
  });

  it('negates it after .next/, which is the only order npm honours', () => {
    // npm applies `files` in order and lets later patterns override earlier
    // ones. Sorting this array alphabetically, or moving the negation above
    // `.next/`, silently re-includes 633MB — with every other assertion here
    // still green, which is exactly why this one exists.
    const included = files.indexOf('.next/');
    const negated = files.indexOf('!.next/cache');

    expect(included).toBeGreaterThanOrEqual(0);
    expect(negated).toBeGreaterThan(included);
  });

  it('still ships everything the server needs at runtime', () => {
    // Verified by installing the packed tarball into an isolated prefix and
    // booting it: /, /sessions, /repositories, /more, /api/worktrees and
    // /api/repositories all returned 200 without `.next/cache` present. Dropping
    // any of these entries instead of the cache would break that.
    for (const entry of ['bin/', 'dist/', '.next/', 'public/', '.env.example', 'release-notes/']) {
      expect(files).toContain(entry);
    }
  });

  it('ships the scripts an agent pane runs at launch (Issue #2934)', () => {
    // `scripts/hooks/` carries the hook relay; `scripts/opencode-v2/` carries
    // `launch.sh`, which an OpenCode V2 pane runs to start its own server. A
    // package without it degrades every OpenCode V2 launch to `--standalone`,
    // with no structured state, and says so only in a log line.
    expect(files).toContain('scripts/hooks/');
    expect(files).toContain('scripts/opencode-v2/');
  });

  it('keeps launch.sh executable in the index (mode 100755)', () => {
    // `prepareOpencodeV2Launch` runs it through `bash`, so the bit is not what
    // makes it work — but a packed tarball preserves what git records, and a
    // user running the script by hand should not meet EACCES.
    const entry = execFileSync('git', ['ls-files', '-s', 'scripts/opencode-v2/launch.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(entry.split(/\s+/)[0]).toBe('100755');
  });

  it('excludes nothing under .next/ beyond the cache', () => {
    // `.next/server`, `.next/static` and `.next/BUILD_ID` are load-bearing. A
    // broader negation (e.g. `!.next/s*`) would pack clean and fail at boot.
    const overreaching = files.filter(
      (entry) => entry.startsWith('!.next/') && entry !== '!.next/cache',
    );

    expect(overreaching).toEqual([]);
  });
});
