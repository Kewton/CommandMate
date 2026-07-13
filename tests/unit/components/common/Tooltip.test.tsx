/**
 * Tests for Tooltip component (Issue #730)
 *
 * Custom tooltip used by ActivityBar icons to provide hover-delayed labels
 * with dark theme styling and a11y-correct semantics.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Tooltip, TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

describe('Tooltip (Issue #730)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports TOOLTIP_DELAY_MS = 100', () => {
    expect(TOOLTIP_DELAY_MS).toBe(100);
  });

  it('renders children initially without a tooltip element', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('shows tooltip after TOOLTIP_DELAY_MS on mouse enter', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Files');
  });

  it('does not show tooltip when mouseLeave fires before delay', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 10);
    });
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('hides tooltip on mouse leave after it became visible', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('clears scheduled timer on unmount (no tooltip flash after unmount)', () => {
    const { unmount } = render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    unmount();
    // Should not throw or warn: timer cleared
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('applies placement="right" class', () => {
    render(
      <Tooltip content="Files" placement="right">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip.className).toMatch(/left-full|right/);
  });

  it('applies dark theme classes', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    // Issue #1082: inverted-surface tokens (theme-following) replace raw gray.
    expect(tooltip.className).toMatch(/bg-foreground/);
    expect(tooltip.className).toMatch(/text-background/);
  });

  it('uses role="tooltip" and aria-hidden="true" (no aria-describedby usage)', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveAttribute('aria-hidden', 'true');
    // child button should not have aria-describedby auto-injected
    const button = screen.getByRole('button', { name: 'Files' });
    expect(button).not.toHaveAttribute('aria-describedby');
  });

  it('preserves child aria-label and does not modify children element', () => {
    render(
      <Tooltip content="Files">
        <button aria-label="Files activity">Icon</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Files activity' });
    expect(btn).toHaveAttribute('aria-label', 'Files activity');
  });

  it('wrapper span has tabIndex=-1 (not Tab-focusable)', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper).toHaveAttribute('tabindex', '-1');
  });

  it('child onClick still fires (event transparency)', () => {
    const onClick = vi.fn();
    render(
      <Tooltip content="Files">
        <button onClick={onClick}>Files</button>
      </Tooltip>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('respects custom delay prop', () => {
    render(
      <Tooltip content="Files" delay={300}>
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
  });
});
