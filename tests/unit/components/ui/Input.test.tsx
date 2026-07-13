/**
 * Tests for Input primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React, { useRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Input } from '@/components/ui/Input';

afterEach(() => cleanup());

describe('Input', () => {
  it('renders a text input with placeholder', () => {
    render(<Input placeholder="Search" />);
    const input = screen.getByPlaceholderText('Search');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'text');
  });

  it('fires onChange with typed value', () => {
    const onChange = vi.fn();
    render(<Input aria-label="name" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('name') as HTMLInputElement).value).toBe('hi');
  });

  it('is not editable when disabled', () => {
    render(<Input aria-label="dis" disabled />);
    expect(screen.getByLabelText('dis')).toBeDisabled();
  });

  it('applies size variant classes', () => {
    const { rerender } = render(<Input aria-label="f" inputSize="sm" />);
    expect(screen.getByLabelText('f').className).toContain('h-8');
    rerender(<Input aria-label="f" inputSize="lg" />);
    expect(screen.getByLabelText('f').className).toContain('text-base');
  });

  it('merges custom className', () => {
    render(<Input aria-label="c" className="max-w-md" />);
    expect(screen.getByLabelText('c').className).toContain('max-w-md');
  });

  it('recedes to surface-2 in dark so it sinks within a surface card (Issue #1049)', () => {
    render(<Input aria-label="d" />);
    const cls = screen.getByLabelText('d').className;
    // light keeps bg-surface; dark drops to the recessed surface-2 fill
    expect(cls).toContain('bg-surface');
    expect(cls).toContain('dark:bg-surface-2');
  });

  it('forwards ref to the input element', () => {
    function Wrapper() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <>
          <Input aria-label="r" ref={ref} />
          <button onClick={() => ref.current?.focus()}>focus</button>
        </>
      );
    }
    render(<Wrapper />);
    fireEvent.click(screen.getByText('focus'));
    expect(screen.getByLabelText('r')).toHaveFocus();
  });
});
