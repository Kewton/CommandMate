/**
 * Issue #3651: the English web app guide names the header's session field the
 * way the English screen draws it — `worktree.agentStatus.otherSessions`
 * ("{count} more"), so "[N more ▾]", not "[N others ▾]".
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GUIDE = path.join(process.cwd(), 'docs/en/user-guide/webapp-guide.md');
const EN_WORKTREE = path.join(process.cwd(), 'locales/en/worktree.json');

/** The "[N … ▾]" labels a guide writes for the other-sessions trigger. */
function otherSessionsLabels(file: string): string[] {
  return fs.readFileSync(file, 'utf8').match(/\[N [^\]\n]*▾\]/g) ?? [];
}

/** The trigger's label as the English screen draws it, with N for the count. */
function screenLabel(): string {
  const dict = JSON.parse(fs.readFileSync(EN_WORKTREE, 'utf8')) as {
    agentStatus: { otherSessions: string };
  };
  return `[${dict.agentStatus.otherSessions.replace('{count}', 'N')} ▾]`;
}

describe('English web app guide matches the session field (Issue #3651)', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function copyOf(text: string): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-guide-3651-'));
    const file = path.join(tmp, 'webapp-guide.md');
    fs.writeFileSync(file, text);
    return file;
  }

  it('the screen draws "[N more ▾]"', () => {
    expect(screenLabel()).toBe('[N more ▾]');
  });

  it('writes the screen label wherever it names the trigger', () => {
    const labels = otherSessionsLabels(GUIDE);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(new Set(labels)).toEqual(new Set([screenLabel()]));
  });

  it('flags the former "[N others ▾]" wording (positive control)', () => {
    const file = copyOf('the session field ([current session][N others ▾])\n');
    expect(otherSessionsLabels(file)).not.toContain(screenLabel());
    expect(otherSessionsLabels(file)).toEqual(['[N others ▾]']);
  });

  it('accepts the screen wording (negative control)', () => {
    const file = copyOf('the session field ([current session][N more ▾])\n');
    expect(otherSessionsLabels(file)).toEqual([screenLabel()]);
  });
});
