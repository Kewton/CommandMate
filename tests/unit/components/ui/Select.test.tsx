/**
 * Tests for Select primitive (Issue #1046: Radix-based UI primitives).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => {
  installRadixJsdomPolyfills();
});

afterEach(() => {
  cleanup();
});

function Fixture({
  onValueChange,
  disabled,
  defaultOpen,
}: {
  onValueChange?: (v: string) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
}) {
  return (
    <Select defaultValue="apple" onValueChange={onValueChange} defaultOpen={defaultOpen}>
      <SelectTrigger aria-label="Fruit" disabled={disabled} data-testid="trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
        <SelectItem value="cherry" disabled>
          Cherry
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

describe('Select', () => {
  it('renders a trigger with the combobox role and selected value', () => {
    render(<Fixture />);
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Apple');
  });

  it('renders options with listbox/option roles when open', () => {
    render(<Fixture defaultOpen />);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    // Radix marks the chosen value with data-state="checked"
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('calls onValueChange when a different option is selected', () => {
    const onValueChange = vi.fn();
    render(<Fixture defaultOpen onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('option', { name: 'Banana' }));
    expect(onValueChange).toHaveBeenCalledWith('banana');
  });

  it('opens via keyboard (ArrowDown) from a closed trigger', () => {
    render(<Fixture />);
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a labelled, separated group when open', () => {
    render(
      <Select defaultValue="apple" defaultOpen>
        <SelectTrigger aria-label="Fruit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Fruits</SelectLabel>
            <SelectItem value="apple">Apple</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="banana">Banana</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByText('Fruits')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('is not operable when disabled', () => {
    render(<Fixture disabled />);
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
