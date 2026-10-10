/**
 * @vitest-environment jsdom
 */

/**
 * The sidebar open/close button (Issue #3512). Replaces the ActivityBar
 * hamburger (#747, `activity-bar-toggle-sidebar`) and the never-mounted
 * `SidebarToggle` (`sidebar-toggle`); the behaviour those tests pinned is
 * pinned here on the new button.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const sidebarMock = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
}));

import { SidebarPanelToggle } from '@/components/layout/SidebarPanelToggle';

beforeEach(() => {
  sidebarMock.isOpen = true;
  sidebarMock.toggle.mockClear();
});

describe('SidebarPanelToggle (Issue #3512)', () => {
  it('says "Close sidebar" and aria-expanded=true while the sidebar is open', () => {
    render(<SidebarPanelToggle testId="sidebar-panel-toggle" />);
    const button = screen.getByTestId('sidebar-panel-toggle');
    expect(button).toHaveAttribute('aria-label', 'Close sidebar');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button.querySelector('svg.lucide-panel-left-close')).not.toBeNull();
  });

  it('says "Open sidebar" and aria-expanded=false while it is closed, with the other panel icon', () => {
    sidebarMock.isOpen = false;
    render(<SidebarPanelToggle testId="sidebar-rail-toggle" />);
    const button = screen.getByTestId('sidebar-rail-toggle');
    expect(button).toHaveAttribute('aria-label', 'Open sidebar');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.querySelector('svg.lucide-panel-left-open')).not.toBeNull();
  });

  it('calls the sidebar context toggle when clicked', () => {
    render(<SidebarPanelToggle testId="sidebar-panel-toggle" />);
    fireEvent.click(screen.getByTestId('sidebar-panel-toggle'));
    expect(sidebarMock.toggle).toHaveBeenCalledTimes(1);
  });

  it('is the same 40px button in both places, so the spot does not move', () => {
    const { unmount } = render(<SidebarPanelToggle testId="sidebar-panel-toggle" />);
    const openClass = screen.getByTestId('sidebar-panel-toggle').className;
    unmount();
    sidebarMock.isOpen = false;
    render(<SidebarPanelToggle testId="sidebar-rail-toggle" />);
    expect(screen.getByTestId('sidebar-rail-toggle').className).toBe(openClass);
    expect(openClass).toMatch(/\bh-10\b/);
    expect(openClass).toMatch(/\bw-10\b/);
  });
});
