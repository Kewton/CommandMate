/**
 * The ja/en guides describe resolving an uncertain relay hold the way the CLI
 * and the API do it (Issue #4082), and no longer tell the reader to resend a
 * held payload by hand.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const COMMAND = 'commandmate relays resolve <relay-id> --payload <payloadId> --attempt <attemptId>';

describe('resolving a relay hold in the CLI operations guide (Issue #4082)', () => {
  for (const [lang, file, heading, stale] of [
    ['ja', 'docs/user-guide/cli-operations-guide.md', '#### 保留を解決する（Issue #4082）', '届いていなければ自分で送り直してください'],
    ['en', 'docs/en/user-guide/cli-operations-guide.md', '#### Resolving a hold (Issue #4082)', 'not arrive, resend it yourself'],
  ] as const) {
    it(`${lang}: the section, the three actions, the API and the attempt field`, () => {
      const guide = read(file);
      expect(guide).toContain(heading);
      for (const action of ['--confirm', '--retry', '--discard']) {
        expect(guide).toContain(`${COMMAND} ${action}`);
      }
      expect(guide).toContain('POST /api/relays/:id/resolve');
      expect(guide).toContain('"action": "confirm" | "retry" | "discard"');
      expect(guide).toContain('`attempt=<attemptId>`');
      expect(guide).toContain('deliveryHold.attemptId');
      expect(guide).toContain('409');
    });

    it(`${lang}: the old "resend it yourself" advice is gone`, () => {
      expect(read(file)).not.toContain(stale);
    });
  }

  it('the CLI help names the same command and flags', () => {
    const source = read('src/cli/commands/relays.ts');
    expect(source).toContain("command('resolve')");
    for (const flag of ["'--payload <id>'", "'--attempt <id>'", "'--confirm'", "'--retry'", "'--discard'"]) {
      expect(source).toContain(flag);
    }
    expect(source).toContain('attempt=${delivery.attemptId}');
  });
});
