/**
 * Tests for Tooltip primitive (Issue #1046).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());
afterEach(() => cleanup());

function Fixture({ defaultOpen }: { defaultOpen?: boolean }) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip defaultOpen={defaultOpen}>
        <TooltipTrigger>More info</TooltipTrigger>
        <TooltipContent>Helpful hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('Tooltip', () => {
  it('shows content with the tooltip role when open', () => {
    render(<Fixture defaultOpen />);
    // Radix renders both a visible tooltip and a visually-hidden a11y copy.
    expect(screen.getAllByText('Helpful hint').length).toBeGreaterThan(0);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('reveals the tooltip when the trigger receives keyboard focus', () => {
    render(<Fixture />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(screen.getByText('More info'));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('hides the tooltip on Escape / blur', () => {
    render(<Fixture />);
    const trigger = screen.getByText('More info');
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('applies an unconditional enter and a closed-gated exit to the content (Issue #1050)', () => {
    render(<Fixture defaultOpen />);
    // Radix's role="tooltip" is the visually-hidden a11y copy; the styled,
    // visible content is the element carrying our base `bg-foreground` class.
    const content = document.querySelector('.bg-foreground');
    expect(content).not.toBeNull();
    const cls = content!.className;
    // Enter is unconditional so instant-open (not just delayed-open) animates.
    expect(cls).toContain('animate-in');
    expect(cls).toContain('fade-in-0');
    expect(cls).toContain('zoom-in-95');
    expect(cls).not.toContain('data-[state=delayed-open]:animate-in');
    // Exit is gated on the closed state.
    expect(cls).toContain('data-[state=closed]:animate-out');
  });
});
