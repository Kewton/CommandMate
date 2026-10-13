/**
 * markEscapeClosedLayer / isEscapeNoLayerClosed (Issue #3670): a layer that
 * closed on an Escape without claiming it, read by a mode underneath.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  isEscapeNoLayerClosed,
  isUnhandledEscape,
  markEscapeClosedLayer,
} from '@/lib/escape-key';

function keydown(key: string, claimed = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, cancelable: true });
  if (claimed) event.preventDefault();
  return event;
}

describe('isEscapeNoLayerClosed (Issue #3670)', () => {
  it('is true for an Escape nobody claimed or closed on', () => {
    expect(isEscapeNoLayerClosed(keydown('Escape'))).toBe(true);
  });

  it('is false for an Escape a layer closed on, which isUnhandledEscape still passes', () => {
    const event = keydown('Escape');
    markEscapeClosedLayer(event);
    expect(isEscapeNoLayerClosed(event)).toBe(false);
    expect(isUnhandledEscape(event)).toBe(true);
  });

  it('marks only the event it was given', () => {
    markEscapeClosedLayer(keydown('Escape'));
    expect(isEscapeNoLayerClosed(keydown('Escape'))).toBe(true);
  });

  it('is false for a claimed Escape and for any other key', () => {
    expect(isEscapeNoLayerClosed(keydown('Escape', true))).toBe(false);
    expect(isEscapeNoLayerClosed(keydown('Enter'))).toBe(false);
  });
});
