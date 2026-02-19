/**
 * Tests for AutoYesToggle component - confirm dialog integration
 *
 * Issue #225: Updated for duration propagation and HH:MM:SS format
 * Issue #314: Updated for AutoYesToggleParams interface (object parameter pattern)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config';

describe('AutoYesToggle', () => {
  const defaultProps = {
    enabled: false,
    expiresAt: null,
    onToggle: vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined),
    lastAutoResponse: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('OFF to ON (should show dialog)', () => {
    it('should show confirm dialog when clicking toggle in OFF state', () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      const toggle = screen.getByRole('switch');
      fireEvent.click(toggle);

      expect(screen.getByText('autoYes.enableTitle')).toBeDefined();
      expect(defaultProps.onToggle).not.toHaveBeenCalled();
    });

    it('should call onToggle with enabled:true and default duration when dialog is confirmed', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith({
          enabled: true,
          duration: DEFAULT_AUTO_YES_DURATION,
          stopPattern: undefined,
        });
      });
    });

    it('should call onToggle with enabled:true and 3-hour duration when selected', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));

      // Select 3h duration button
      fireEvent.click(screen.getByText('autoYes.durations.3h'));

      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith({
          enabled: true,
          duration: 10800000,
          stopPattern: undefined,
        });
      });
    });

    it('should not call onToggle when dialog is cancelled', () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('common.cancel'));

      expect(defaultProps.onToggle).not.toHaveBeenCalled();
    });

    it('should close dialog after cancel', () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('common.cancel'));

      expect(screen.queryByText('autoYes.enableTitle')).toBeNull();
    });
  });

  describe('ON to OFF (no dialog)', () => {
    it('should call onToggle with enabled:false directly without showing dialog', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={true} />);
      fireEvent.click(screen.getByRole('switch'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith({ enabled: false });
      });
      expect(screen.queryByText('autoYes.enableTitle')).toBeNull();
    });
  });

  describe('formatTimeRemaining HH:MM:SS', () => {
    it('should display MM:SS format when under 1 hour', () => {
      const expiresAt = Date.now() + 59 * 60 * 1000 + 30 * 1000; // ~59:30
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={true}
          expiresAt={expiresAt}
        />
      );

      const timeDisplay = screen.getByLabelText('Time remaining');
      // Should be in MM:SS format (no hours prefix)
      expect(timeDisplay.textContent).toMatch(/^\d{2}:\d{2}$/);
    });

    it('should display H:MM:SS format when 1 hour or more', () => {
      const expiresAt = Date.now() + 3600001; // Just over 1 hour
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={true}
          expiresAt={expiresAt}
        />
      );

      const timeDisplay = screen.getByLabelText('Time remaining');
      // Should be in H:MM:SS format
      expect(timeDisplay.textContent).toMatch(/^\d+:\d{2}:\d{2}$/);
    });

    it('should display multi-hour format for 8 hours', () => {
      const expiresAt = Date.now() + 28800000; // 8 hours
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={true}
          expiresAt={expiresAt}
        />
      );

      const timeDisplay = screen.getByLabelText('Time remaining');
      // Should start with 7 or 8 (depending on exact timing)
      expect(timeDisplay.textContent).toMatch(/^[78]:\d{2}:\d{2}$/);
    });
  });

  // ==========================================================================
  // Issue #314: stopPattern propagation tests
  // ==========================================================================
  describe('Issue #314: stopPattern propagation', () => {
    it('should pass stopPattern through onToggle when entered in dialog', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));

      // Enter stop pattern
      const input = screen.getByTestId('stop-pattern-input');
      fireEvent.change(input, { target: { value: 'error|fatal' } });

      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith({
          enabled: true,
          duration: DEFAULT_AUTO_YES_DURATION,
          stopPattern: 'error|fatal',
        });
      });
    });

    it('should pass undefined stopPattern when no pattern entered', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith({
          enabled: true,
          duration: DEFAULT_AUTO_YES_DURATION,
          stopPattern: undefined,
        });
      });
    });
  });
});
