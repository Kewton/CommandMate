/**
 * WorktreeDesktopLayout's activity slot across a pin toggle, and the body's
 * stacking context (Issue #3589, consistency review).
 *
 * - Pinning / unpinning changes the slot's style only: the pane inside is NOT
 *   remounted, so its state (an unsaved Env draft) survives.
 * - The right pane is its own stacking context (`isolate`), so a `z-30`
 *   floating inside the body cannot rise above the overlaid pane (`z-20`). The
 *   real paint order is checked by tests/e2e/activity-pane-overlay-3589.spec.ts.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';

function renderLayout(pinned: boolean) {
  return (
    <WorktreeDesktopLayout
      activityPane={<input data-testid="pane-field" defaultValue="" />}
      rightPane={<div data-testid="body" />}
      activityPanePinned={pinned}
    />
  );
}

describe('WorktreeDesktopLayout — pin toggle (Issue #3589)', () => {
  it('keeps the same pane element and its typed value when pinned, then unpinned', () => {
    const { rerender } = render(renderLayout(false));
    const field = screen.getByTestId('pane-field') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'draft' } });
    const slot = screen.getByTestId('activity-pane-slot');

    rerender(renderLayout(true));
    expect(screen.getByTestId('activity-pane-slot')).toBe(slot);
    expect(slot).toHaveAttribute('data-pinned', 'true');
    expect(screen.getByTestId('pane-field')).toBe(field);
    expect(field.value).toBe('draft');

    rerender(renderLayout(false));
    expect(slot).toHaveAttribute('data-pinned', 'false');
    expect(screen.getByTestId('pane-field')).toBe(field);
    expect(field.value).toBe('draft');
  });

  it('still lays the slot out as an overlay unpinned and as a column with a resizer pinned', () => {
    const { rerender } = render(renderLayout(false));
    const layout = screen.getByTestId('desktop-layout');
    expect(screen.getByTestId('activity-pane-slot').className).toMatch(/\babsolute\b/);
    expect(layout.querySelector('[role="separator"]')).toBeNull();

    rerender(renderLayout(true));
    expect(screen.getByTestId('activity-pane-slot').className).not.toMatch(/\babsolute\b/);
    expect(layout.querySelector('[role="separator"]')).not.toBeNull();
  });
});

describe('WorktreeDesktopLayout — the body is its own stacking context (Issue #3589)', () => {
  it('isolates the right pane so what floats inside it stays under the overlay', () => {
    render(renderLayout(false));
    expect(screen.getByTestId('right-pane-slot').className).toMatch(/\bisolate\b/);
    // The layout root itself stays a plain positioned box: it does not create
    // a stacking context, so body-level portals keep their order.
    expect(screen.getByTestId('desktop-layout').className).not.toMatch(/\b(isolate|z-\d+)\b/);
  });
});
