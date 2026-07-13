/**
 * Tests for Tabs primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';

afterEach(() => cleanup());

function Fixture({ variant }: { variant?: 'underline' | 'pill' }) {
  return (
    <Tabs defaultValue="one" variant={variant}>
      <TabsList aria-label="sections">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Panel One</TabsContent>
      <TabsContent value="two">Panel Two</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('renders tablist/tab/tabpanel roles with the default panel active', () => {
    render(<Fixture />);
    expect(screen.getByRole('tablist', { name: 'sections' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel One');
  });

  it('switches the active panel when another tab is selected', () => {
    render(<Fixture />);
    // Radix tabs use automatic activation: focusing a tab selects it.
    const two = screen.getByRole('tab', { name: 'Two' });
    fireEvent.mouseDown(two);
    two.focus();
    expect(two).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel Two');
  });

  it('only mounts the active tab panel', () => {
    render(<Fixture />);
    expect(screen.getByText('Panel One')).toBeInTheDocument();
    expect(screen.queryByText('Panel Two')).toBeNull();
  });

  it('applies the pill variant classes on the list', () => {
    render(<Fixture variant="pill" />);
    expect(screen.getByRole('tablist').className).toContain('bg-muted');
  });

  it('applies the underline variant classes on the list by default', () => {
    render(<Fixture />);
    expect(screen.getByRole('tablist').className).toContain('border-b');
  });
});
