/**
 * isUnhandledEscape (Issue #3611): the one check every document / window
 * Escape listener under a stacked layer shares.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { isUnhandledEscape } from '@/lib/escape-key';

function keydown(key: string, claimed: boolean): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true });
  if (claimed) event.preventDefault();
  return event;
}

describe('isUnhandledEscape (Issue #3611)', () => {
  it('is true for an Escape nobody claimed', () => {
    expect(isUnhandledEscape(keydown('Escape', false))).toBe(true);
  });

  it('is false for an Escape a layer above already claimed', () => {
    expect(isUnhandledEscape(keydown('Escape', true))).toBe(false);
  });

  it('is false for any other key', () => {
    expect(isUnhandledEscape(keydown('Enter', false))).toBe(false);
    expect(isUnhandledEscape(keydown('Esc', false))).toBe(false);
  });
});
