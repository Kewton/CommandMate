/**
 * Issue #3593: Tooltip takes an optional layer (`zIndex`) so a tooltip inside
 * a popover (the header's "N more" list) is drawn above it. The shared default
 * stays where it was.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from '@/components/common/Tooltip';

function show(): HTMLElement {
  fireEvent.focus(screen.getByRole('button'));
  return screen.getByRole('tooltip', { hidden: true });
}

describe('[#3593] Tooltip layer', () => {
  it('draws the bubble on the layer it is given', () => {
    render(
      <Tooltip content="Model: sonnet" zIndex={66}>
        <button type="button">row</button>
      </Tooltip>,
    );
    expect(show().style.zIndex).toBe('66');
  });

  it('negative control: without one, the default layer (z-40) is unchanged', () => {
    render(
      <Tooltip content="Files">
        <button type="button">Files</button>
      </Tooltip>,
    );
    const bubble = show();
    expect(bubble.style.zIndex).toBe('');
    expect(bubble.className).toContain('z-40');
  });
});
