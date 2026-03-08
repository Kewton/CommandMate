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
  SIDEBAR_VIEW_MODE_STORAGE_KEY,
  DEFAULT_VIEW_MODE,
} from '@/contexts/SidebarContext';

// Test component to access context
function TestConsumer() {
  const context = useSidebarContext();
  return (
    <div>
      <span data-testid="isOpen">{String(context.isOpen)}</span>
      <span data-testid="width">{context.width}</span>
      <span data-testid="isMobileDrawerOpen">{String(context.isMobileDrawerOpen)}</span>
      <span data-testid="viewMode">{context.viewMode}</span>
      <button data-testid="toggle" onClick={context.toggle}>Toggle</button>
      <button data-testid="setWidth" onClick={() => context.setWidth(400)}>Set Width</button>
      <button data-testid="openMobileDrawer" onClick={context.openMobileDrawer}>Open Drawer</button>
      <button data-testid="closeMobileDrawer" onClick={context.closeMobileDrawer}>Close Drawer</button>
      <button data-testid="setViewModeFlat" onClick={() => context.setViewMode('flat')}>Set Flat</button>
      <button data-testid="setViewModeGrouped" onClick={() => context.setViewMode('grouped')}>Set Grouped</button>
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

  describe('viewMode', () => {
    it('should have default viewMode as grouped', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('viewMode').textContent).toBe('grouped');
    });

    it('should change viewMode to flat', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      act(() => {
        screen.getByTestId('setViewModeFlat').click();
      });

      expect(screen.getByTestId('viewMode').textContent).toBe('flat');
    });

    it('should change viewMode back to grouped', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      act(() => {
        screen.getByTestId('setViewModeFlat').click();
      });
      expect(screen.getByTestId('viewMode').textContent).toBe('flat');

      act(() => {
        screen.getByTestId('setViewModeGrouped').click();
      });
      expect(screen.getByTestId('viewMode').textContent).toBe('grouped');
    });

    it('should persist viewMode to localStorage', () => {
      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      act(() => {
        screen.getByTestId('setViewModeFlat').click();
      });

      const stored = localStorage.getItem(SIDEBAR_VIEW_MODE_STORAGE_KEY);
      expect(stored).toBe('flat');
    });

    it('should load viewMode from localStorage on mount', () => {
      localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'flat');

      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      // After useEffect runs, viewMode should be loaded from localStorage
      expect(screen.getByTestId('viewMode').textContent).toBe('flat');
    });

    it('should use default when localStorage has invalid value', () => {
      localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'invalid');

      render(
        <SidebarProvider>
          <TestConsumer />
        </SidebarProvider>
      );

      expect(screen.getByTestId('viewMode').textContent).toBe('grouped');
    });
  });

  describe('DEFAULT_VIEW_MODE', () => {
    it('should export default view mode constant as grouped', () => {
      expect(DEFAULT_VIEW_MODE).toBe('grouped');
    });
  });
});
