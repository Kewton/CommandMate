/**
 * Issue #3771 (item 2b): an error is logged as its name, its code and the
 * first 80 characters of its message — the pane's text may be in the rest.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { describeError } from '@/lib/session/strict-prompt-answer-io';

describe('[#3771] describeError', () => {
  it('keeps the name and code and cuts the message at 80 characters', () => {
    const error = Object.assign(new TypeError(`bad ${'x'.repeat(200)} SECRET-TAIL`), { code: 'ERR_X' });
    const text = describeError(error);
    expect(text.startsWith('TypeError code=ERR_X: bad ')).toBe(true);
    expect(text).not.toContain('SECRET-TAIL');
    expect(text.length).toBeLessThanOrEqual('TypeError code=ERR_X: '.length + 80);
  });

  it('folds newlines of a multi-row message into spaces', () => {
    expect(describeError(new Error('row one\nrow two'))).toBe('Error: row one row two');
  });

  it('negative control: a short message without a code is kept whole', () => {
    expect(describeError(new Error('tmux gone'))).toBe('Error: tmux gone');
  });

  it('reads a non-Error throw too', () => {
    expect(describeError('plain text')).toBe('string: plain text');
  });
});
