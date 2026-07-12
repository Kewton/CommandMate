/**
 * Tests for Card primitives (Issue #1042: cva + cn migration)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/Card';

describe('Card', () => {
  it('renders base classes and default md padding', () => {
    render(<Card data-testid="card">body</Card>);
    const el = screen.getByTestId('card');
    // base now uses semantic surface/border tokens (Issue #1049)
    expect(el.className).toContain('rounded-lg');
    expect(el.className).toContain('border-border');
    expect(el.className).toContain('bg-surface');
    expect(el.className).toContain('p-4');
    expect(el.className).not.toContain('hover:shadow-md');
  });

  it('adds the hover transition classes when hover is set', () => {
    render(
      <Card data-testid="card" hover>
        body
      </Card>
    );
    expect(screen.getByTestId('card').className).toContain('hover:shadow-md');
  });

  it('adds motion-safe hover-lift / active-press classes when interactive is set (Issue #1050)', () => {
    render(
      <Card data-testid="card" interactive>
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    // motion-safe: so the transform is suppressed under prefers-reduced-motion
    expect(cls).toContain('motion-safe:hover:-translate-y-0.5');
    expect(cls).toContain('hover:shadow-lg');
    expect(cls).toContain('motion-safe:active:translate-y-0');
    expect(cls).toContain('cursor-pointer');
  });

  it('stays flat (no lift) when interactive is not set', () => {
    render(<Card data-testid="card">body</Card>);
    expect(screen.getByTestId('card').className).not.toContain('translate-y-0.5');
  });

  it('renders the elevated variant with a gradient and stronger shadow (Issue #1049)', () => {
    render(
      <Card data-testid="card" variant="elevated">
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    expect(cls).toContain('bg-gradient-to-b');
    expect(cls).toContain('from-surface');
    expect(cls).toContain('to-surface-2');
    expect(cls).toContain('shadow-md');
  });

  it('renders the interactive variant with accent hover border and lift (Issue #1049)', () => {
    render(
      <Card data-testid="card" variant="interactive">
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    expect(cls).toContain('hover:border-accent-500');
    expect(cls).toContain('motion-safe:hover:-translate-y-0.5');
    expect(cls).toContain('transition-all');
  });

  it('interactive variant is keyboard-focusable: cursor + focus-visible mirrors hover (Issue #1049)', () => {
    render(
      <Card data-testid="card" variant="interactive">
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    expect(cls).toContain('cursor-pointer');
    expect(cls).toContain('focus-visible:ring-ring');
    expect(cls).toContain('focus-visible:border-accent-500');
    expect(cls).toContain('motion-safe:focus-visible:-translate-y-0.5');
    expect(cls).toContain('focus-visible:shadow-md');
  });

  it('defaults to the default variant with no elevated/interactive classes', () => {
    render(<Card data-testid="card">body</Card>);
    const cls = screen.getByTestId('card').className;
    expect(cls).not.toContain('bg-gradient-to-b');
    expect(cls).not.toContain('hover:border-accent-500');
  });

  it.each([
    ['none', ''],
    ['sm', 'p-3'],
    ['md', 'p-4'],
    ['lg', 'p-6'],
  ] as const)('applies %s padding', (padding, expected) => {
    render(
      <Card data-testid="card" padding={padding}>
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    if (expected) {
      expect(cls).toContain(expected);
    } else {
      expect(cls).not.toMatch(/\bp-\d/);
    }
  });

  it('merges a custom className with last-wins for conflicting padding', () => {
    render(
      <Card data-testid="card" padding="md" className="p-8">
        body
      </Card>
    );
    const cls = screen.getByTestId('card').className;
    expect(cls).toContain('p-8');
    expect(cls).not.toContain('p-4');
  });

  it('renders header/title/content/footer subcomponents with their classes and children', () => {
    render(
      <Card>
        <CardHeader data-testid="header">
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent data-testid="content">Content</CardContent>
        <CardFooter data-testid="footer">Footer</CardFooter>
      </Card>
    );
    expect(screen.getByTestId('header').className).toContain('mb-3');
    expect(screen.getByRole('heading', { name: 'Title' }).className).toContain('font-semibold');
    expect(screen.getByTestId('content')).toHaveTextContent('Content');
    expect(screen.getByTestId('footer').className).toContain('border-t');
  });

  it('merges custom className on subcomponents', () => {
    render(
      <CardHeader data-testid="header" className="mt-2">
        h
      </CardHeader>
    );
    const cls = screen.getByTestId('header').className;
    expect(cls).toContain('mb-3');
    expect(cls).toContain('mt-2');
  });
});
