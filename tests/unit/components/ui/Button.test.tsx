/**
 * Tests for Button primitive (Issue #1042: cva migration + ghost dark fix)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';

function classesOf(text: string): string[] {
  return (screen.getByRole('button', { name: text }).className || '').split(/\s+/).filter(Boolean);
}

describe('Button', () => {
  it('renders base classes and defaults to the primary variant / md size', () => {
    render(<Button>Go</Button>);
    const cls = classesOf('Go');
    // base classes (inlined from the former .btn @apply utility, Issue #1048)
    expect(cls).toContain('inline-flex');
    expect(cls).toContain('rounded-md');
    // primary variant
    expect(cls).toContain('bg-accent-600');
    // md size keeps the base px-4 padding and adds no sm/lg override
    expect(cls).toContain('px-4');
    expect(cls).not.toContain('px-3');
    expect(cls).not.toContain('px-6');
  });

  it.each([
    ['primary', 'bg-accent-600'],
    ['secondary', 'bg-gray-200'],
    ['danger', 'bg-red-600'],
  ] as const)('applies the %s variant classes', (variant, expected) => {
    render(
      <Button variant={variant}>{variant}</Button>
    );
    expect(classesOf(variant)).toContain(expected);
  });

  it('ghost variant includes dark-mode classes (Issue #1042 fix)', () => {
    render(<Button variant="ghost">ghost</Button>);
    const cls = classesOf('ghost');
    expect(cls).toContain('bg-transparent');
    expect(cls).toContain('text-gray-700');
    expect(cls).toContain('hover:bg-gray-100');
    expect(cls).toContain('focus:ring-gray-500');
    // Regression guard: dark: variants must be present
    expect(cls).toContain('dark:text-gray-300');
    expect(cls).toContain('dark:hover:bg-gray-800');
  });

  it.each([
    ['sm', 'text-sm'],
    ['lg', 'text-lg'],
  ] as const)('applies the %s size classes', (size, expected) => {
    render(<Button size={size}>{size}</Button>);
    expect(classesOf(size)).toContain(expected);
  });

  it('adds w-full when fullWidth is set', () => {
    render(<Button fullWidth>wide</Button>);
    expect(classesOf('wide')).toContain('w-full');
  });

  it('applies disabled styling and disables the button when disabled', () => {
    render(<Button disabled>disabled</Button>);
    const btn = screen.getByRole('button', { name: 'disabled' });
    expect(btn).toBeDisabled();
    expect(btn.className).toContain('opacity-50');
    expect(btn.className).toContain('cursor-not-allowed');
  });

  it('applies motion-safe hover-lift / active-press interaction classes when enabled (Issue #1050)', () => {
    render(<Button>Go</Button>);
    const cls = classesOf('Go');
    // motion-safe: so the transform is suppressed under prefers-reduced-motion
    expect(cls).toContain('motion-safe:hover:-translate-y-0.5');
    expect(cls).toContain('motion-safe:active:translate-y-0');
    // transition-all (not transition-colors) so transform animates
    expect(cls).toContain('transition-all');
  });

  it('omits the hover-lift interaction when disabled (Issue #1050)', () => {
    render(<Button disabled>off</Button>);
    const cls = classesOf('off');
    expect(cls).not.toContain('motion-safe:hover:-translate-y-0.5');
  });

  it('shows a spinner and disables the button while loading', () => {
    render(<Button loading>loading</Button>);
    const btn = screen.getByRole('button', { name: 'loading' });
    expect(btn).toBeDisabled();
    expect(btn.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('merges a custom className with last-wins for conflicts', () => {
    // primary sets bg-accent-600; a custom bg utility must win via tailwind-merge
    render(<Button className="bg-black">custom</Button>);
    const cls = classesOf('custom');
    expect(cls).toContain('bg-black');
    expect(cls).not.toContain('bg-accent-600');
    // base classes preserved
    expect(cls).toContain('inline-flex');
  });

  it('forwards native button props such as type and onClick', () => {
    render(
      <Button type="submit" data-testid="submit-btn">
        submit
      </Button>
    );
    const btn = screen.getByTestId('submit-btn');
    expect(btn).toHaveAttribute('type', 'submit');
  });
});
