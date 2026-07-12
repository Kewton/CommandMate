/**
 * Tests for Skeleton primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Skeleton } from '@/components/ui/Skeleton';

afterEach(() => cleanup());

describe('Skeleton', () => {
  it('renders a pulsing placeholder hidden from assistive tech', () => {
    render(<Skeleton data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('animate-pulse');
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('merges custom sizing className', () => {
    render(<Skeleton data-testid="sk" className="h-4 w-32" />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('h-4');
    expect(el.className).toContain('w-32');
  });
});
