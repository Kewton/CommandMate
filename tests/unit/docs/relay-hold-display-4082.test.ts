/**
 * The ja/en guides describe how a relay hold is told, shown and counted, and
 * what an expiry while held does (Issue #4082, work item b), in step with the
 * code that does it.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

describe('telling, showing and counting holds in the CLI operations guide (Issue #4082)', () => {
  for (const [lang, file, heading] of [
    ['ja', 'docs/user-guide/cli-operations-guide.md', '#### 保留の知らせ・表示・件数（Issue #4082）'],
    ['en', 'docs/en/user-guide/cli-operations-guide.md', '#### Telling, showing and counting holds (Issue #4082)'],
  ] as const) {
    it(`${lang}: the section names the same fields and outputs`, () => {
      const guide = read(file);
      expect(guide).toContain(heading);
      const section = guide.slice(guide.indexOf(heading));
      for (const token of [
        'relay=<relay-id>',
        'payload=<',
        'attempt=<attemptId>',
        '`heldCount`',
        '`held=<n>`',
        '`, <n> held`',
        '`, <n> held now`',
        '`relaysHeld`',
        '`replyDiscarded: true`',
        '`attempting`',
        '`days`',
      ]) {
        expect(section, `${lang} lacks ${token}`).toContain(token);
      }
    });
  }

  it('the code prints what the guides say', () => {
    expect(read('src/cli/commands/relays.ts')).toContain('held=${response.heldCount}');
    expect(read('src/cli/commands/task.ts')).toContain('held} held');
    expect(read('src/cli/commands/task.ts')).toContain('relaysHeld');
    expect(read('src/cli/commands/report.ts')).toContain('held now');
    expect(read('src/cli/commands/report.ts')).toContain('relaysHeld');
    expect(read('src/app/api/relays/route.ts')).toContain('heldCount');
    expect(read('src/app/api/relays/[relayId]/resolve/route.ts')).toContain('replyDiscarded');
  });
});
