/**
 * The URL the guides tell users to open must be the address CommandMate binds
 * (Issue #2113).
 *
 * server.ts binds `CM_BIND`, default `127.0.0.1`, while README and the two setup guides
 * advertised `http://localhost:3000`. On macOS `localhost` resolves ::1 before 127.0.0.1,
 * so with anything holding `::1:3000` the browser reaches that process instead — measured
 * 2026-08-27: `127.0.0.1:3000` answered in 14ms while `localhost:3000` timed out at 10s.
 * Because the squatter was also a Next.js app, the browser rendered CommandMate's OWN
 * chunk-reload error screen while never having talked to CommandMate.
 *
 * The guard covers ja and en together: these files are mirrors, and fixing one while the
 * other still says `localhost` leaves half the readers with the original defect. It is a
 * pure documentation guard by design — nothing else in the suite reads these files, so
 * without it the doc half of the fix is unprotected (verified by reverting all six files:
 * the entire repository stayed green).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/**
 * The three documents the Issue's acceptance condition names, each with its mirror.
 * WSL2 setup is deliberately absent: there `localhost` is the Windows->WSL2 forwarding
 * name, a different mechanism from the local resolver this Issue is about.
 */
const GUIDES: ReadonlyArray<{ lang: 'ja' | 'en'; file: string }> = [
  { lang: 'en', file: 'README.md' },
  { lang: 'ja', file: 'docs/ja/README.md' },
  { lang: 'ja', file: 'docs/user-guide/cli-setup-guide.md' },
  { lang: 'en', file: 'docs/en/user-guide/cli-setup-guide.md' },
  { lang: 'ja', file: 'docs/user-guide/webapp-guide.md' },
  { lang: 'en', file: 'docs/en/user-guide/webapp-guide.md' },
];

function read(file: string): string {
  const abs = path.join(REPO_ROOT, file);
  expect(fs.existsSync(abs), `${file} is missing`).toBe(true);
  return fs.readFileSync(abs, 'utf-8');
}

describe('browser-access guidance matches the default bind (Issue #2113)', () => {
  it.each(GUIDES)('$file ($lang) sends the reader to 127.0.0.1', ({ file }) => {
    expect(read(file)).toContain('http://127.0.0.1:3000');
  });

  it.each(GUIDES)('$file ($lang) no longer advertises localhost', ({ file }) => {
    // A default-port localhost URL anywhere in these three documents is the defect: they
    // contain no reverse-proxy or tunnel examples, where `localhost:3000` would be right.
    expect(read(file)).not.toContain('http://localhost:3000');
  });

  it('explains why, so the URL does not get "corrected" back', () => {
    for (const { file } of GUIDES) {
      const text = read(file);
      expect(text, `${file} must say what localhost resolves to`).toContain('::1');
      expect(text, `${file} must name CM_BIND or the bind default`).toContain('127.0.0.1');
    }
  });
});
