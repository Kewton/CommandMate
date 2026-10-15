/**
 * markEscapeClosedLayer / isEscapeNoLayerClosed (Issue #3670): a layer that
 * closed on an Escape without claiming it, read by a mode underneath; and
 * isCoveredByViewportLayer: whether such a layer is behind a viewport layer.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  isCoveredByViewportLayer,
  isEscapeNoLayerClosed,
  isUnhandledEscape,
  markEscapeClosedLayer,
  VIEWPORT_LAYER_ATTRIBUTE,
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

describe('isCoveredByViewportLayer (Issue #3670)', () => {
  function layer(z: string, viewport: boolean): HTMLElement {
    const el = document.createElement('div');
    el.style.zIndex = z;
    if (viewport) el.setAttribute(VIEWPORT_LAYER_ATTRIBUTE, '');
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is true under a viewport layer with a higher z-index', () => {
    const panel = layer('50', false);
    layer('55', true);
    expect(isCoveredByViewportLayer(panel)).toBe(true);
  });

  it('is false above a viewport layer with a lower z-index, and with none', () => {
    const panel = layer('50', false);
    expect(isCoveredByViewportLayer(panel)).toBe(false);
    layer('40', true);
    expect(isCoveredByViewportLayer(panel)).toBe(false);
  });

  it('breaks a z-index tie by document order', () => {
    const earlier = layer('50', true);
    const panel = layer('50', false);
    expect(isCoveredByViewportLayer(panel)).toBe(false);
    earlier.remove();
    layer('50', true);
    expect(isCoveredByViewportLayer(panel)).toBe(true);
  });

  it('ignores an element without a z-index and a layer that is not a viewport layer', () => {
    const auto = layer('', false);
    layer('55', true);
    expect(isCoveredByViewportLayer(auto)).toBe(false);
    const panel = layer('50', false);
    document.querySelector(`[${VIEWPORT_LAYER_ATTRIBUTE}]`)?.removeAttribute(VIEWPORT_LAYER_ATTRIBUTE);
    layer('60', false);
    expect(isCoveredByViewportLayer(panel)).toBe(false);
  });
});
