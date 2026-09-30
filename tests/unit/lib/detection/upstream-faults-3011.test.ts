/**
 * Issue #3011: Command Code's context-window error is an upstream fault
 * (`context-limit`), and only its error wording is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';

const REAL_FRAME = readFileSync(
  join(__dirname, '../../../fixtures/upstream-faults/context-limit-command-code-3011.txt'),
  'utf8',
);

describe('context-limit upstream fault (Issue #3011)', () => {
  it('matches the frame measured on a Command Code session', () => {
    const match = matchUpstreamFault(REAL_FRAME);
    expect(match?.fault.id).toBe('context-limit');
    expect(match?.fault.selfRetrying).toBe(false);
    expect(match?.matchedText).toContain('maximum context length is 1048576 tokens');
  });

  it('wins over the generic api-error on the same frame', () => {
    const match = matchUpstreamFault('API Error: 400 maximum context length is 200000 tokens');
    expect(match?.fault.id).toBe('context-limit');
  });

  it.each([
    ['a healthy frame', '❯ \n  ? for shortcuts\n'],
    ['prose quoting the words', 'Context window is large; the maximum context length is unlimited here.'],
    ['a different limit message', 'Prompt is too long'],
  ])('does not match %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)).toBeNull();
  });
});
