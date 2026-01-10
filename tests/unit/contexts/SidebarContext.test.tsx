/**
 * Tests for SidebarContext
 *
 * Tests the sidebar state management context
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import {
  SidebarProvider,
  useSidebarContext,
  DEFAULT_SIDEBAR_WIDTH,
} from '@/contexts/SidebarContext';

// Test component to access context
function TestConsumer() {
  const context = useSidebarContext();
  return (
    <div>
      <span data-testid="isOpen">{String(context.isOpen)}</span>
      <span data-testid="width">{context.width}</span>
      <span data-testid="isMobileDrawerOpen">{String(context.isMobileDrawerOpen)}</span>
      <button data-testid="toggle" onClick={context.toggle}>Toggle</button>
      <button data-testid="setWidth" onClick={() => context.setWidth(400)}>Set Width</button>
      <button data-testid="openMobileDrawer" onClick={context.openMobileDrawer}>Open Drawer</button>
      <button data-testid="closeMobileDrawer" onClick={context.closeMobileDrawer}>Close Drawer</button>
    </div>
  );
}

describe('SidebarContext', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SidebarProvider', () => {
    it('should provide default state', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('isOpen').textContent).toBe('true');
      expect(screen.getByTestId('width').textContent).toBe(String(DEFAULT_SIDEBAR_WIDTH));
      expect(screen.getByTestId('isMobileDrawerOpen').textContent).toBe('false');
    });

    it('should toggle sidebar open state', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('isOpen').textContent).toBe('true');

      act(() => {
        screen.getByTestId('toggle').click();
      });

      expect(screen.getByTestId('isOpen').textContent).toBe('false');

      act(() => {
        screen.getByTestId('toggle').click();
      });

      expect(screen.getByTestId('isOpen').textContent).toBe('true');
    });

    it('should set sidebar width', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      act(() => {
        screen.getByTestId('setWidth').click();
      });

      expect(screen.getByTestId('width').textContent).toBe('400');
    });

    it('should open mobile drawer', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('isMobileDrawerOpen').textContent).toBe('false');

      act(() => {
        screen.getByTestId('openMobileDrawer').click();
      });

      expect(screen.getByTestId('isMobileDrawerOpen').textContent).toBe('true');
    });

    it('should close mobile drawer', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      act(() => {
        screen.getByTestId('openMobileDrawer').click();
      });

      expect(screen.getByTestId('isMobileDrawerOpen').textContent).toBe('true');

      act(() => {
        screen.getByTestId('closeMobileDrawer').click();
      });

      expect(screen.getByTestId('isMobileDrawerOpen').textContent).toBe('false');
    });
  });

  describe('useSidebarContext', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useSidebarContext must be used within a SidebarProvider');

      consoleSpy.mockRestore();
    });
  });

  describe('Initial state from props', () => {
    it('should accept initialOpen prop', () => {
      render(
        <SidebarProvider initialOpen={false}>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('isOpen').textContent).toBe('false');
    });

    it('should accept initialWidth prop', () => {
      render(
        <SidebarProvider initialWidth={350}>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('width').textContent).toBe('350');
    });
  });

  describe('DEFAULT_SIDEBAR_WIDTH', () => {
    it('should export default width constant', () => {
      expect(DEFAULT_SIDEBAR_WIDTH).toBe(288); // 72 * 4 = 288px (w-72)
    });
  });
});
