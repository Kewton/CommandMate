/**
 * Tests for RouteLoading (Issue #1118: route-level loading.tsx fallback)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteLoading } from '@/components/common/RouteLoading';

describe('RouteLoading', () => {
  it('renders a page-outline skeleton announced as status', () => {
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
});
