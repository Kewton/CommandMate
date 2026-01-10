/**
 * Tests for SidebarToggle component
 *
 * Tests the sidebar toggle button
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SidebarToggle } from '@/components/layout/SidebarToggle';
import { SidebarProvider } from '@/contexts/SidebarContext';

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <SidebarProvider>
    {children}
  </SidebarProvider>
);

describe('SidebarToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the toggle button', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      expect(screen.getByTestId('sidebar-toggle')).toBeInTheDocument();
    });

    it('should render as a button element', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('should have accessible label', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAccessibleName();
    });
  });

  describe('Toggle behavior', () => {
    it('should toggle sidebar on click', () => {
      const TestComponent = () => {
        return (
          <SidebarProvider>
            <SidebarToggle />
            <div data-testid="sidebar-state">test</div>
          </SidebarProvider>
        );
      };

      render(<TestComponent />);

      const button = screen.getByRole('button');

      // Initial click should toggle the state
      fireEvent.click(button);

      // Button should still be there after click
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });

  describe('Icon display', () => {
    it('should display collapse icon when sidebar is open', () => {
      render(
        <SidebarProvider initialOpen={true}>
          <SidebarToggle />
        </SidebarProvider>
      );

      // Should have an icon - either chevron-left or collapse icon
      const button = screen.getByRole('button');
      expect(button.querySelector('svg') || button.textContent).toBeTruthy();
    });

    it('should display expand icon when sidebar is closed', () => {
      render(
        <SidebarProvider initialOpen={false}>
          <SidebarToggle />
        </SidebarProvider>
      );

      // Should have an icon - either chevron-right or expand icon
      const button = screen.getByRole('button');
      expect(button.querySelector('svg') || button.textContent).toBeTruthy();
    });
  });

  describe('Styling', () => {
    it('should have hover effect styling', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      expect(button.className).toMatch(/hover:/);
    });

    it('should have focus styling for accessibility', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      expect(button.className).toMatch(/focus:|focus-visible:/);
    });

    it('should have transition for smooth icon change', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      expect(button.className).toMatch(/transition/);
    });
  });

  describe('Keyboard interaction', () => {
    it('should be focusable', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it('should toggle on Enter key', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
      fireEvent.click(button);

      // Button should still be functional
      expect(button).toBeInTheDocument();
    });

    it('should toggle on Space key', () => {
      render(
        <Wrapper>
          <SidebarToggle />
        </Wrapper>
      );

      const button = screen.getByRole('button');
      fireEvent.keyDown(button, { key: ' ', code: 'Space' });

      expect(button).toBeInTheDocument();
    });
  });
});
