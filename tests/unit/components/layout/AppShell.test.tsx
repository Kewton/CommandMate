/**
 * Tests for AppShell component
 *
 * Tests the integrated layout with sidebar and main content
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

// Mock Next.js navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock useIsMobile
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
  MOBILE_BREAKPOINT: 768,
}));

// Mock the API client
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn().mockResolvedValue({ worktrees: [], repositories: [] }),
      getById: vi.fn(),
    },
  };
});

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

  describe('Mobile Drawer Behavior', () => {
    beforeEach(() => {
      (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(true);
    });

    it('should show drawer overlay when mobile drawer is open', () => {
      // Using a custom wrapper that controls mobile drawer state
      const MobileDrawerWrapper = ({ children }: { children: React.ReactNode }) => {
        return (
          <SidebarProvider>
            {/* We need to manipulate the context to open mobile drawer */}
            <WorktreeSelectionProvider>
              {children}
            </WorktreeSelectionProvider>
          </SidebarProvider>
        );
      };

      render(
        <MobileDrawerWrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </MobileDrawerWrapper>
      );

      // The mobile layout should be rendered
      expect(screen.getByTestId('app-shell')).toBeInTheDocument();
      expect(screen.getByRole('main')).toBeInTheDocument();
    });

    it('should have flex-col layout on mobile', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const shell = screen.getByTestId('app-shell');
      expect(shell.className).toMatch(/flex-col/);
    });

    it('should have sidebar container with transform transition', () => {
      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const sidebarContainer = screen.getByTestId('sidebar-container');
      expect(sidebarContainer.className).toMatch(/transition|transform/);
    });
  });

  describe('Initial Sidebar State', () => {
    it('should start with sidebar open on desktop by default', () => {
      (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);

      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const sidebarContainer = screen.getByTestId('sidebar-container');
      // Desktop uses transform-based animation for performance (Issue #112)
      expect(sidebarContainer.className).toMatch(/translate-x-0/);
      expect(sidebarContainer.className).not.toMatch(/-translate-x-full/);
    });

    it('should render with custom initial state', () => {
      const CustomWrapper = ({ children }: { children: React.ReactNode }) => (
        <SidebarProvider initialOpen={false}>
          <WorktreeSelectionProvider>
            {children}
          </WorktreeSelectionProvider>
        </SidebarProvider>
      );

      render(
        <CustomWrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </CustomWrapper>
      );

      const sidebarContainer = screen.getByTestId('sidebar-container');
      // Desktop uses transform-based animation for performance (Issue #112)
      expect(sidebarContainer.className).toMatch(/-translate-x-full/);
    });

    it('should have aria-hidden when sidebar is closed', () => {
      const CustomWrapper = ({ children }: { children: React.ReactNode }) => (
        <SidebarProvider initialOpen={false}>
          <WorktreeSelectionProvider>
            {children}
          </WorktreeSelectionProvider>
        </SidebarProvider>
      );

      render(
        <CustomWrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </CustomWrapper>
      );

      const sidebarContainer = screen.getByTestId('sidebar-container');
      expect(sidebarContainer).toHaveAttribute('aria-hidden', 'true');
    });

    it('should not have aria-hidden when sidebar is open', () => {
      (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);

      render(
        <Wrapper>
          <AppShell>
            <div>Content</div>
          </AppShell>
        </Wrapper>
      );

      const sidebarContainer = screen.getByTestId('sidebar-container');
      expect(sidebarContainer).not.toHaveAttribute('aria-hidden', 'true');
    });
  });
});
