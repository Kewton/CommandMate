/**
 * Tests for Textarea primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Textarea } from '@/components/ui/Textarea';

afterEach(() => cleanup());

describe('Textarea', () => {
  it('renders with placeholder and rows', () => {
    render(<Textarea placeholder="Notes" rows={4} />);
    const el = screen.getByPlaceholderText('Notes');
    expect(el.tagName).toBe('TEXTAREA');
    expect(el).toHaveAttribute('rows', '4');
  });

  it('fires onChange with typed value', () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="desc" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('desc'), { target: { value: 'text' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('desc') as HTMLTextAreaElement).value).toBe('text');
  });

  it('is not editable when disabled', () => {
    render(<Textarea aria-label="d" disabled />);
    expect(screen.getByLabelText('d')).toBeDisabled();
  });

  it('merges custom className', () => {
    render(<Textarea aria-label="c" className="h-40" />);
    expect(screen.getByLabelText('c').className).toContain('h-40');
  });
});
