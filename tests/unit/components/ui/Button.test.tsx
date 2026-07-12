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
  it('renders base btn class and defaults to the primary variant / md size', () => {
    render(<Button>Go</Button>);
    const cls = classesOf('Go');
    expect(cls).toContain('btn');
    expect(cls).toContain('btn-primary');
    // md size contributes no extra size class
    expect(cls).not.toContain('btn-sm');
    expect(cls).not.toContain('btn-lg');
  });

  it.each([
    ['primary', 'btn-primary'],
    ['secondary', 'btn-secondary'],
    ['danger', 'btn-danger'],
  ] as const)('applies the %s variant class', (variant, expected) => {
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
    ['sm', 'btn-sm'],
    ['lg', 'btn-lg'],
  ] as const)('applies the %s size class', (size, expected) => {
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

  it('shows a spinner and disables the button while loading', () => {
    render(<Button loading>loading</Button>);
    const btn = screen.getByRole('button', { name: 'loading' });
    expect(btn).toBeDisabled();
    expect(btn.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('merges a custom className with last-wins for conflicts', () => {
    render(<Button className="btn-primary text-black">custom</Button>);
    const cls = classesOf('custom');
    // custom class is appended
    expect(cls).toContain('text-black');
    // base btn class preserved
    expect(cls).toContain('btn');
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
