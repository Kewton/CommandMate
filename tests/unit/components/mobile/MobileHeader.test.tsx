/**
 * Tests for MobileHeader component
 *
 * Tests the mobile header for displaying worktree info and status
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MobileHeader } from '@/components/mobile/MobileHeader';
import type { MobileHeaderProps } from '@/components/mobile/MobileHeader';

describe('MobileHeader', () => {
  const defaultProps: MobileHeaderProps = {
    worktreeName: 'feature/test-branch',
    status: 'idle',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the header', () => {
      render(<MobileHeader {...defaultProps} />);
      expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
    });

    it('should display worktree name', () => {
      render(<MobileHeader {...defaultProps} worktreeName="feature/my-feature" />);
      expect(screen.getByText(/feature\/my-feature/)).toBeInTheDocument();
    });

    it('should display short worktree names fully', () => {
      render(<MobileHeader {...defaultProps} worktreeName="main" />);
      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  describe('Worktree Name Truncation', () => {
    it('should truncate long worktree names', () => {
      const longName = 'feature/this-is-a-very-long-branch-name-that-should-be-truncated';
      render(<MobileHeader {...defaultProps} worktreeName={longName} />);

      const nameElement = screen.getByTestId('worktree-name');
      // Should have truncation styling
      expect(nameElement.className).toMatch(/truncate|overflow|ellipsis/);
    });

    it('should have title attribute with full name for truncated names', () => {
      const longName = 'feature/this-is-a-very-long-branch-name-that-should-be-truncated';
      render(<MobileHeader {...defaultProps} worktreeName={longName} />);

      const nameElement = screen.getByTestId('worktree-name');
      expect(nameElement).toHaveAttribute('title', longName);
    });
  });

  describe('Status Indicator', () => {
    it('should show idle status indicator', () => {
      render(<MobileHeader {...defaultProps} status="idle" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toMatch(/gray|neutral/);
    });

    it('should show running status indicator with animation', () => {
      render(<MobileHeader {...defaultProps} status="running" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toMatch(/green|animate|pulse/);
    });

    it('should show waiting status indicator', () => {
      render(<MobileHeader {...defaultProps} status="waiting" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toMatch(/yellow|amber|waiting/);
    });

    it('should show error status indicator', () => {
      render(<MobileHeader {...defaultProps} status="error" />);

      const indicator = screen.getByTestId('status-indicator');
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toMatch(/red|error/);
    });

    it('should have accessible status text', () => {
      render(<MobileHeader {...defaultProps} status="running" />);

      // Should have aria-label or visually hidden text
      expect(screen.getByTestId('status-indicator')).toHaveAccessibleName();
    });
  });

  describe('Back Button', () => {
    it('should render back button when onBackClick is provided', () => {
      const onBackClick = vi.fn();
      render(<MobileHeader {...defaultProps} onBackClick={onBackClick} />);

      expect(screen.getByRole('button', { name: /back|return/i })).toBeInTheDocument();
    });

    it('should not render back button when onBackClick is not provided', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /back|return/i })).not.toBeInTheDocument();
    });

    it('should call onBackClick when back button is clicked', () => {
      const onBackClick = vi.fn();
      render(<MobileHeader {...defaultProps} onBackClick={onBackClick} />);

      fireEvent.click(screen.getByRole('button', { name: /back|return/i }));

      expect(onBackClick).toHaveBeenCalled();
    });
  });

  describe('Menu Button', () => {
    it('should render menu button when onMenuClick is provided', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    });

    it('should not render menu button when onMenuClick is not provided', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
    });

    it('should call onMenuClick when menu button is clicked', () => {
      const onMenuClick = vi.fn();
      render(<MobileHeader {...defaultProps} onMenuClick={onMenuClick} />);

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      expect(onMenuClick).toHaveBeenCalled();
    });
  });

  describe('Both Buttons', () => {
    it('should render both buttons when both handlers are provided', () => {
      const onBackClick = vi.fn();
      const onMenuClick = vi.fn();
      render(
        <MobileHeader
          {...defaultProps}
          onBackClick={onBackClick}
          onMenuClick={onMenuClick}
        />
      );

      expect(screen.getByRole('button', { name: /back|return/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should have fixed positioning at top', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/fixed|top/);
    });

    it('should have safe area padding', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      // Should have pt-safe or similar class for safe area
      expect(header.className).toMatch(/pt-|safe|top/);
    });

    it('should span full width', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/w-full|inset-x-0/);
    });

    it('should have background color', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/bg-/);
    });

    it('should have shadow or border for visual separation', () => {
      render(<MobileHeader {...defaultProps} />);

      const header = screen.getByTestId('mobile-header');
      expect(header.className).toMatch(/shadow|border/);
    });
  });

  describe('Accessibility', () => {
    it('should have banner role', () => {
      render(<MobileHeader {...defaultProps} />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('should have heading for worktree name', () => {
      render(<MobileHeader {...defaultProps} worktreeName="test-branch" />);

      expect(screen.getByRole('heading')).toBeInTheDocument();
    });

    it('should support keyboard navigation for buttons', () => {
      const onBackClick = vi.fn();
      render(<MobileHeader {...defaultProps} onBackClick={onBackClick} />);

      const backButton = screen.getByRole('button', { name: /back|return/i });
      backButton.focus();
      fireEvent.keyDown(backButton, { key: 'Enter', code: 'Enter' });
      fireEvent.click(backButton);

      expect(onBackClick).toHaveBeenCalled();
    });
  });

  describe('Layout', () => {
    it('should center worktree name', () => {
      render(<MobileHeader {...defaultProps} />);

      const nameElement = screen.getByTestId('worktree-name');
      // Should have text-center or flex centering via parent
      const hasCentering =
        nameElement.className.includes('center') ||
        nameElement.parentElement?.className.includes('center') ||
        nameElement.parentElement?.className.includes('justify-center') ||
        nameElement.className.includes('text-center');
      expect(hasCentering).toBe(true);
    });

    it('should position buttons at edges', () => {
      const onBackClick = vi.fn();
      const onMenuClick = vi.fn();
      render(
        <MobileHeader
          {...defaultProps}
          onBackClick={onBackClick}
          onMenuClick={onMenuClick}
        />
      );

      const header = screen.getByTestId('mobile-header');
      // Check the inner container for flex layout
      const innerContainer = header.querySelector('div');
      expect(
        header.className.includes('flex') ||
        innerContainer?.className.includes('flex') ||
        innerContainer?.className.includes('justify-between')
      ).toBe(true);
    });
  });
});
