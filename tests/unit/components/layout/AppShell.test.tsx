/**
 * Tests for AppShell component
 *
 * Tests the integrated layout with sidebar and main content
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

// Mock useIsMobile
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
  MOBILE_BREAKPOINT: 768,
}));

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    getAll: vi.fn().mockResolvedValue({ worktrees: [], repositories: [] }),
    getById: vi.fn(),
  },
}));

import { useIsMobile } from '@/hooks/useIsMobile';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <SidebarProvider>
    <WorktreeSelectionProvider>
      {children}
    </WorktreeSelectionProvider>
  </SidebarProvider>
);

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Desktop Layout', () => {
    it('should render with sidebar and main content areas', () => {
      render(
        <Wrapper>
          <AppShell>
            <div data-testid="main-content">Main Content</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('main-content')).toBeInTheDocument();
    });

    it('should render sidebar when open', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('sidebar-container')).toBeInTheDocument();
    });

    it('should render sidebar toggle button', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('sidebar-toggle')).toBeInTheDocument();
    });

    it('should have full height layout', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const shell = screen.getByTestId('app-shell');
      expect(shell.className).toMatch(/h-screen|h-full|min-h-screen/);
    });

    it('should use flex layout', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const shell = screen.getByTestId('app-shell');
      expect(shell.className).toMatch(/flex/);
    });
  });

  describe('Mobile Layout', () => {
    beforeEach(() => {
      (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it('should render mobile layout', () => {
      render(
        <Wrapper>
          <AppShell>
            <div data-testid="main-content">Main Content</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByTestId('main-content')).toBeInTheDocument();
    });

    it('should not show sidebar by default on mobile', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      // On mobile, the sidebar should be hidden initially (as a drawer)
      const sidebarContainer = screen.queryByTestId('sidebar-container');
      if (sidebarContainer) {
        // If it exists, it should have hidden/closed styling
        expect(sidebarContainer.className).toMatch(/hidden|w-0|-translate-x/);
      }
    });
  });

  describe('Children rendering', () => {
    it('should render children in main content area', () => {
      render(
        <Wrapper>
          <AppShell>
            <div data-testid="child-component">Child Component</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('child-component')).toBeInTheDocument();
      expect(screen.getByText('Child Component')).toBeInTheDocument();
    });

    it('should render multiple children', () => {
      render(
        <Wrapper>
          <AppShell>
            <div data-testid="child-1">First</div>
            <div data-testid="child-2">Second</div>
          </AppShell>
        </Wrapper>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have appropriate landmark roles', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      // Main content should be a main landmark
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('should have sidebar as complementary or navigation landmark', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      // Sidebar should be a complementary landmark (aside) or navigation
      const complementary = screen.queryByRole('complementary');
      const navigation = screen.queryByRole('navigation');
      expect(complementary || navigation).toBeTruthy();
    });
  });
});
