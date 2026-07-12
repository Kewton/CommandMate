/**
 * Tests for Switch primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from '@/components/ui/Switch';

afterEach(() => cleanup());

describe('Switch', () => {
  it('renders with the switch role and reflects checked state', () => {
    render(<Switch checked aria-label="toggle" onCheckedChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'toggle' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAttribute('data-state', 'checked');
  });

  it('calls onCheckedChange when clicked', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} aria-label="t" onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 't' }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', () => {
    const onCheckedChange = vi.fn();
    render(<Switch disabled aria-label="d" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole('switch', { name: 'd' });
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
