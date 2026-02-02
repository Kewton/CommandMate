/**
 * Tests for BranchMismatchAlert component
 * Issue #111: Branch visualization feature
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import type { BranchMismatchAlertProps } from '@/components/worktree/BranchMismatchAlert';

describe('BranchMismatchAlert', () => {
  const defaultProps: BranchMismatchAlertProps = {
    isBranchMismatch: true,
    currentBranch: 'feature/new-branch',
    initialBranch: 'main',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Visibility', () => {
    it('should render when isBranchMismatch is true', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      expect(screen.getByTestId('branch-mismatch-alert')).toBeInTheDocument();
    });

    it('should not render when isBranchMismatch is false', () => {
      render(
        <BranchMismatchAlert
          {...defaultProps}
          isBranchMismatch={false}
        />
      );
      expect(screen.queryByTestId('branch-mismatch-alert')).not.toBeInTheDocument();
    });

    it('should not render when initialBranch is null', () => {
      render(
        <BranchMismatchAlert
          {...defaultProps}
          initialBranch={null}
        />
      );
      expect(screen.queryByTestId('branch-mismatch-alert')).not.toBeInTheDocument();
    });
  });

  describe('Content', () => {
    it('should display current branch name', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      expect(screen.getByText(/feature\/new-branch/)).toBeInTheDocument();
    });

    it('should display initial branch name', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      expect(screen.getByText(/main/)).toBeInTheDocument();
    });

    it('should show warning icon', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      const alert = screen.getByTestId('branch-mismatch-alert');
      // Check for AlertTriangle icon (SVG)
      const svg = alert.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  describe('Dismiss Functionality', () => {
    it('should have a close button', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      expect(screen.getByRole('button', { name: /dismiss|close/i })).toBeInTheDocument();
    });

    it('should hide when close button is clicked', async () => {
      render(<BranchMismatchAlert {...defaultProps} />);

      const closeButton = screen.getByRole('button', { name: /dismiss|close/i });
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.queryByTestId('branch-mismatch-alert')).not.toBeInTheDocument();
      });
    });

    it('should reappear when currentBranch changes after being dismissed', async () => {
      const { rerender } = render(<BranchMismatchAlert {...defaultProps} />);

      // Dismiss the alert
      const closeButton = screen.getByRole('button', { name: /dismiss|close/i });
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(screen.queryByTestId('branch-mismatch-alert')).not.toBeInTheDocument();
      });

      // Change the current branch
      rerender(
        <BranchMismatchAlert
          {...defaultProps}
          currentBranch="feature/another-branch"
        />
      );

      // Alert should reappear
      await waitFor(() => {
        expect(screen.getByTestId('branch-mismatch-alert')).toBeInTheDocument();
      });
    });
  });

  describe('Styling', () => {
    it('should have warning color scheme (amber/yellow)', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      const alert = screen.getByTestId('branch-mismatch-alert');
      expect(alert.className).toMatch(/amber|yellow|warning/);
    });

    it('should have proper layout', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      const alert = screen.getByTestId('branch-mismatch-alert');
      expect(alert.className).toMatch(/flex|items-center/);
    });
  });

  describe('Accessibility', () => {
    it('should have role="alert"', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('should have accessible close button', () => {
      render(<BranchMismatchAlert {...defaultProps} />);
      const closeButton = screen.getByRole('button', { name: /dismiss|close/i });
      expect(closeButton).toHaveAccessibleName();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string currentBranch gracefully', () => {
      render(
        <BranchMismatchAlert
          isBranchMismatch={true}
          currentBranch=""
          initialBranch="main"
        />
      );
      // Should still render the alert
      expect(screen.getByTestId('branch-mismatch-alert')).toBeInTheDocument();
    });

    it('should escape special characters in branch names (XSS prevention)', () => {
      render(
        <BranchMismatchAlert
          isBranchMismatch={true}
          currentBranch="<script>alert('xss')</script>"
          initialBranch="main"
        />
      );
      // Branch name should be escaped (displayed as text, not executed)
      expect(screen.getByText(/<script>/)).toBeInTheDocument();
      // No script execution (React auto-escapes)
    });

    it('should handle very long branch names', () => {
      const longBranchName = 'feature/' + 'a'.repeat(100);
      render(
        <BranchMismatchAlert
          isBranchMismatch={true}
          currentBranch={longBranchName}
          initialBranch="main"
        />
      );
      // Should render without breaking
      expect(screen.getByTestId('branch-mismatch-alert')).toBeInTheDocument();
    });
  });
});
