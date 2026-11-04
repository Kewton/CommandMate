/**
 * Issue #4146: a test that replaces `Date.now` has to put it back however it
 * ends. A restore written as the test's last line is skipped by a failing
 * assertion above it, and every later test in the file runs on a frozen clock.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Whether each `Date.now = vi.fn` in `source` has a restore that a failure cannot skip before it. */
function restoresOnFailure(source: string): boolean {
  const assignment = source.indexOf('Date.now = vi.fn');
  if (assignment < 0) return true;
  const before = source.slice(0, assignment);
  const finished = before.lastIndexOf('onTestFinished(');
  if (finished < 0) return false;
  return before.slice(finished).includes('Date.now = originalDateNow');
}

describe('Date.now in WorktreeDetailRefactored TC-4', () => {
  const source = readFileSync(resolve(process.cwd(), 'tests/unit/components/WorktreeDetailRefactored.test.tsx'), 'utf8');

  it('is restored by onTestFinished, before it is replaced', () => {
    expect(source).toContain('Date.now = vi.fn');
    expect(restoresOnFailure(source)).toBe(true);
  });

  it('positive control: the shape it replaced, a restore on the last line, does not pass', () => {
    const old = [
      'const originalDateNow = Date.now;',
      'Date.now = vi.fn(() => currentTime);',
      'expect(mockFetch).toHaveBeenCalled();',
      'Date.now = originalDateNow;',
    ].join('\n');
    expect(restoresOnFailure(old)).toBe(false);
  });
});
