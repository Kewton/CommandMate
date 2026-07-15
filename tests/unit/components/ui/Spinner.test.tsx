/**
 * Tests for Spinner primitive (Issue #1118: consolidate hand-written spinners)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Spinner } from '@/components/ui/Spinner';

function renderSpinner(ui: React.ReactElement): SVGSVGElement {
  const { container } = render(ui);
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg as SVGSVGElement;
}

describe('Spinner', () => {
  it('renders an svg with the animate-spin class (selector compat with legacy tests)', () => {
    const svg = renderSpinner(<Spinner />);
    expect(svg.classList.contains('animate-spin')).toBe(true);
    // Tailwind-doc style track + arc: both follow currentColor
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('defaults to the md size (h-5 w-5)', () => {
    const svg = renderSpinner(<Spinner />);
    expect(svg.classList.contains('h-5')).toBe(true);
    expect(svg.classList.contains('w-5')).toBe(true);
  });

  it.each([
    ['xs', 'h-3', 'w-3'],
    ['sm', 'h-4', 'w-4'],
    ['md', 'h-5', 'w-5'],
    ['lg', 'h-6', 'w-6'],
    ['xl', 'h-8', 'w-8'],
  ] as const)('applies the %s size classes', (size, h, w) => {
    const svg = renderSpinner(<Spinner size={size} />);
    expect(svg.classList.contains(h)).toBe(true);
    expect(svg.classList.contains(w)).toBe(true);
  });

  it('inherits currentColor by default (no text- color class)', () => {
    const svg = renderSpinner(<Spinner />);
    const classes = Array.from(svg.classList);
    expect(classes.some((c) => c.startsWith('text-'))).toBe(false);
  });

  it('applies the accent variant colors for both themes', () => {
    const svg = renderSpinner(<Spinner variant="accent" />);
    expect(svg.classList.contains('text-accent-600')).toBe(true);
    expect(svg.classList.contains('dark:text-accent-400')).toBe(true);
  });

  it('applies the muted variant color', () => {
    const svg = renderSpinner(<Spinner variant="muted" />);
    expect(svg.classList.contains('text-muted-foreground')).toBe(true);
  });

  it('is aria-hidden by default (decorative)', () => {
    const svg = renderSpinner(<Spinner />);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('allows overriding aria attributes for standalone use', () => {
    const svg = renderSpinner(
      <Spinner aria-hidden={undefined} role="status" aria-label="Loading" />
    );
    expect(svg.getAttribute('role')).toBe('status');
    expect(svg.getAttribute('aria-label')).toBe('Loading');
  });

  it('merges a custom className with last-wins for size conflicts', () => {
    const svg = renderSpinner(<Spinner size="sm" className="h-10 w-10" />);
    expect(svg.classList.contains('h-10')).toBe(true);
    expect(svg.classList.contains('h-4')).toBe(false);
  });
});
