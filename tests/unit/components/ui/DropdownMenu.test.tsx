/**
 * Tests for DropdownMenu primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());
afterEach(() => cleanup());

function Fixture({
  onSelect,
  defaultOpen,
}: {
  onSelect?: () => void;
  defaultOpen?: boolean;
}) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSelect}>Rename</DropdownMenuItem>
        <DropdownMenuItem disabled>Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu', () => {
  it('exposes an aria-haspopup trigger that is collapsed by default', () => {
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders menu items with the menu/menuitem roles when open', () => {
    render(<Fixture defaultOpen />);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'data-disabled'
    );
  });

  it('calls onSelect when a menu item is activated', () => {
    const onSelect = vi.fn();
    render(<Fixture defaultOpen onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders checkbox and radio items with their roles when open', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked>Show hidden</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="asc">
            <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show hidden' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('menuitemradio', { name: 'Ascending' })).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('opens with the keyboard from the trigger', () => {
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('applies Radix data-state enter/exit animation classes to the content (Issue #1050)', () => {
    render(<Fixture defaultOpen />);
    const cls = screen.getByRole('menu').className;
    expect(cls).toContain('data-[state=open]:animate-in');
    expect(cls).toContain('data-[state=closed]:animate-out');
    expect(cls).toContain('data-[side=bottom]:slide-in-from-top-2');
  });
});
