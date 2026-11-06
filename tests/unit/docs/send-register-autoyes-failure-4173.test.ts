/**
 * Issue #4173: the embedded agent-operations guide, `send --help` and the user guides (ja, en)
 * say the same four things about what happens after the message has gone out. Not word for
 * word: the point of each (exit 0, a warning, not withdrawn, left on) has to appear in each.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createSendCommand } from '@/cli/commands/send';
import { AGENT_OPERATIONS_GUIDE } from '@/cli/docs/agent-operations';

function helpOf(command: Command): string {
  let text = '';
  command.configureOutput({ writeOut: (chunk) => void (text += chunk), writeErr: (chunk) => void (text += chunk) });
  command.outputHelp();
  return text;
}

const root = path.resolve(__dirname, '../../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const help = flat(helpOf(createSendCommand()));
const guide = flat(AGENT_OPERATIONS_GUIDE);

describe('[#4173] send: what follows a message that has gone out', () => {
  it('a failure to register after sending is a warning and exit 0, for any reason (help and guide)', () => {
    for (const text of [help, guide]) {
      expect(text).toContain('any other failure to register');
      expect(text).toMatch(/warning and exit 0/);
      expect(text).toContain('not send it again');
    }
  });

  it('an --auto-yes applied after the message fails as a warning and exit 0 (help, guide, ja, en)', () => {
    for (const text of [help, guide]) {
      expect(text).toContain('applied after the message');
      expect(text).toContain('that is a warning and exit 0');
      expect(text).toContain('the warning has the command that enables it');
    }
    expect(read('docs/en/user-guide/cli-operations-guide.md')).toContain('a failure is a warning and exit 0');
    expect(read('docs/user-guide/cli-operations-guide.md')).toMatch(/--auto-yes[^\n]*警告[^\n]*exit 0/);
  });

  it('a server that names no grant is not asked to withdraw one (help, guide, ja)', () => {
    for (const text of [help, guide]) {
      expect(text).toContain('too old to name its grants');
      expect(text).toContain('is not asked to withdraw one either');
    }
    expect(read('docs/user-guide/cli-operations-guide.md')).toContain('grant の識別子を返さない古いサーバー');
  });

  it('an --auto-yes with no role, pin or --reply-to stays on after a refused send (help, guide)', () => {
    for (const text of [help, guide]) {
      expect(text).toContain('with no role, pin or --reply-to');
      expect(text).toContain('cannot tell a grant it armed from one already on');
      expect(text).toContain('a refused send leaves it on');
    }
  });

  it('negative control: the old wording, a conflict-only warning, is gone from the guide', () => {
    expect(guide).not.toContain('a roster that kept changing is a warning and exit 0, with the command');
  });
});
