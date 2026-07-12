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
    // base classes (inlined from the former .card @apply utility, Issue #1048)
    expect(el.className).toContain('rounded-lg');
    expect(el.className).toContain('border');
    expect(el.className).toContain('bg-white');
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
