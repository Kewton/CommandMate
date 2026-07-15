/**
 * Tests for Badge primitive (Issue #1042: cva + cn migration)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/ui/Badge';

describe('Badge', () => {
  it('renders base classes and defaults to the gray variant', () => {
    render(<Badge data-testid="badge">Neutral</Badge>);
    const cls = screen.getByTestId('badge').className;
    // base classes (inlined from the former .badge @apply utility, Issue #1048)
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('inline-flex');
    // gray variant (Issue #1082: semantic muted token)
    expect(cls).toContain('bg-muted');
  });

  it.each([
    ['success', 'bg-success-subtle'],
    ['warning', 'bg-warning-subtle'],
    ['error', 'bg-danger-subtle'],
    ['info', 'bg-accent-100'],
    ['gray', 'bg-muted'],
  ] as const)('applies the %s variant classes', (variant, expected) => {
    render(
      <Badge data-testid="badge" variant={variant}>
        {variant}
      </Badge>
    );
    expect(screen.getByTestId('badge').className).toContain(expected);
  });

  it('does not render the dot span by default', () => {
    render(<Badge data-testid="badge">No dot</Badge>);
    expect(screen.getByTestId('badge').querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('renders a dot with the variant color when dot is set', () => {
    render(
      <Badge data-testid="badge" variant="error" dot>
        Failed
      </Badge>
    );
    const dot = screen.getByTestId('badge').querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('bg-danger');
    expect(dot?.className).toContain('rounded-full');
  });

  it('merges a custom className with the badge classes', () => {
    render(
      <Badge data-testid="badge" variant="success" className="ml-2">
        ok
      </Badge>
    );
    const cls = screen.getByTestId('badge').className;
    expect(cls).toContain('bg-success-subtle');
    expect(cls).toContain('ml-2');
  });
});
