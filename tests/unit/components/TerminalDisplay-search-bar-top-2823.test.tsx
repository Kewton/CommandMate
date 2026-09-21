/**
 * Where TerminalDisplay's search bar opens (Issue #2823).
 *
 * On the phone the surface pill (`MobileTerminalTab`, `z-30`) sits over the
 * terminal's top-right corner, and the bar at `top-2` opened under it with its
 * "next" and "close" buttons hidden. The phone now passes
 * `searchBarTopClassName`; everyone else keeps `top-2`. The pixel claim (no
 * control is covered) is the e2e spec's: `tests/e2e/mobile-search-2823.spec.ts`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';

/** The bar's positioned wrapper: the parent of its `role="search"` root. */
function openBarWrapper(): HTMLElement {
  act(() => {
    window.dispatchEvent(new CustomEvent('terminal-search-open'));
  });
  const wrapper = screen.getByRole('search').parentElement;
  expect(wrapper).not.toBeNull();
  return wrapper!;
}

describe('[#2823] the terminal search bar position', () => {
  it('keeps the pre-#2823 class list by default', () => {
    render(<TerminalDisplay output="row 1" isActive />);
    expect(openBarWrapper().className).toBe('absolute top-2 right-2 z-10');
  });

  it('replaces top-2 with the class it is given, rather than adding to it', () => {
    render(<TerminalDisplay output="row 1" isActive searchBarTopClassName="top-16" />);
    const classes = openBarWrapper().className.split(' ');
    expect(classes).toEqual(['absolute', 'top-16', 'right-2', 'z-10']);
    expect(classes).not.toContain('top-2');
  });
});
