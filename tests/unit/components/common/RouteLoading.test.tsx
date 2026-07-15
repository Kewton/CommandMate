/**
 * Tests for RouteLoading (Issue #1118: route-level loading.tsx fallback;
 * Issue #1184: neutral shape that no longer reads as a half-rendered Home).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RouteLoading } from '@/components/common/RouteLoading';

afterEach(() => cleanup());

describe('RouteLoading', () => {
  it('renders a pulsing indicator announced as status', () => {
    render(<RouteLoading />);
    const root = screen.getByTestId('route-loading');
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('Loading page');
    expect(root.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('contains no naked loading text', () => {
    render(<RouteLoading />);
    expect(screen.getByTestId('route-loading').textContent).toBe('');
  });

  it('hides the decorative dots from assistive tech, leaving one status label', () => {
    render(<RouteLoading />);
    const root = screen.getByTestId('route-loading');
    root.querySelectorAll('.animate-pulse').forEach((dot) => {
      expect(dot.closest('[aria-hidden="true"]')).not.toBeNull();
    });
  });

  it('fills the viewport and centers the indicator so the swap into the real shell stays stable', () => {
    render(<RouteLoading />);
    const root = screen.getByTestId('route-loading');
    // Occupying the full viewport keeps the #1118 intent: no blank flash and no
    // scrollbar/height jump when the real page mounts its own AppShell.
    expect(root.className).toContain('min-h-screen');
    expect(root.className).toContain('items-center');
    expect(root.className).toContain('justify-center');
  });

  describe('neutral shape (Issue #1184)', () => {
    it('does not reproduce the Home bento outline', () => {
      render(<RouteLoading />);
      const root = screen.getByTestId('route-loading');
      // Home is `container-custom py-8` wrapping a heading plus a multi-column
      // card grid. Matching that shape is what made every route — worktree
      // detail included — flash a screen that looked like a half-drawn Home.
      expect(root.className).not.toContain('container-custom');
      expect(root.querySelectorAll('[class*="container-custom"]').length).toBe(0);
      expect(root.querySelectorAll('[class*="grid-cols-"]').length).toBe(0);
    });

    it('draws no page structure — every mark is the same small dot', () => {
      render(<RouteLoading />);
      const marks = screen.getByTestId('route-loading').querySelectorAll('.animate-pulse');
      expect(marks.length).toBe(3);
      marks.forEach((mark) => {
        expect(mark.className).toContain('rounded-full');
        // No heading bar and no card blocks: uniform dots evoke no screen.
        expect(mark.className).toContain('h-2.5');
        expect(mark.className).toContain('w-2.5');
      });
    });

    it('tints the dots with muted-foreground so they stay visible on the light background', () => {
      render(<RouteLoading />);
      const marks = screen.getByTestId('route-loading').querySelectorAll('.animate-pulse');
      marks.forEach((mark) => {
        // `bg-muted` is a slab colour for large placeholder blocks; at dot size
        // it is invisible against the light `--background` (Issue #1184).
        expect(mark.className).toContain('bg-muted-foreground');
        // `\b` would not do: `-` is a word boundary, so it matches the
        // `bg-muted` prefix of `bg-muted-foreground`.
        expect(mark.className).not.toMatch(/(^|\s)bg-muted(\s|$)/);
      });
    });
  });

  it('staggers the pulse via classes covered by the global reduced-motion reset', () => {
    render(<RouteLoading />);
    const marks = screen.getByTestId('route-loading').querySelectorAll('.animate-pulse');
    // globals.css (#1050) forces animation-duration/-delay under
    // prefers-reduced-motion, so animation stays in `animate-pulse` +
    // `animation-delay` rather than a component-local media query.
    const delays = [...marks].map((m) =>
      /\[animation-delay:(\d+)ms\]/.exec(m.className)?.[1]
    );
    expect(delays).toEqual(['0', '150', '300']);
  });
});
