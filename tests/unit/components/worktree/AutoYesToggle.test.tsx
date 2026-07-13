/**
 * Tests for AutoYesToggle component - confirm dialog integration
 *
 * Issue #225: Updated for duration propagation and HH:MM:SS format
 * Issue #314: Updated for AutoYesToggleParams interface (object parameter pattern)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { DEFAULT_AUTO_YES_DURATION, AUTO_YES_COUNTDOWN_INTERVAL_MS } from '@/config/auto-yes-config';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';

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
    vi.useRealTimers();
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
      // [Issue #1114] The Modal plays a 200ms exit animation before
      // unmounting, so the dialog disappears after the exit window.
      vi.useFakeTimers();
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('common.cancel'));

      act(() => {
        vi.advanceTimersByTime(EXIT_ANIMATION_DURATION_MS);
      });
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
      const expiresAt = Date.now() + 3600000 + 30000; // 1 hour + 30s margin for render timing
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
  // Issue #525: Per-agent Auto-Yes display
  // ==========================================================================
  describe('Issue #525: Per-agent display', () => {
    it('should display agent name in label when cliToolName is provided and enabled', () => {
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={true}
          expiresAt={Date.now() + 3600000}
          cliToolName="claude"
        />
      );

      const target = screen.getByLabelText('Auto Yes target');
      expect(target.textContent).toContain('Claude');
    });

    it('should display agent name in label when cliToolName is provided and disabled', () => {
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={false}
          cliToolName="claude"
        />
      );

      const target = screen.getByLabelText('Auto Yes target');
      expect(target.textContent).toContain('Claude');
    });

    it('should not display agent indicator when cliToolName is not provided', () => {
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={false}
        />
      );

      expect(screen.queryByLabelText('Auto Yes target')).toBeNull();
    });

    it('should pass cliToolName to confirm dialog for per-agent title', () => {
      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={false}
          cliToolName="codex"
        />
      );
      fireEvent.click(screen.getByRole('switch'));

      // Dialog should show tool-specific title
      expect(screen.getByText(/autoYes\.enableTitleWithTool/)).toBeDefined();
    });
  });

  // ==========================================================================
  // Issue #959: UI reflects expiry the instant the countdown reaches 00:00
  // ==========================================================================
  describe('Issue #959: countdown reaching zero disables the toggle in the UI', () => {
    it('flips the toggle to OFF and hides the countdown when expiresAt is reached', () => {
      vi.useFakeTimers();
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);

      render(
        <AutoYesToggle {...defaultProps} enabled={true} expiresAt={now + 2000} />
      );

      // Initially ON with a visible countdown.
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByLabelText('Time remaining')).toBeDefined();

      // Advance to the exact expiration instant and let the 1s tick fire.
      act(() => {
        vi.setSystemTime(now + 2000);
        vi.advanceTimersByTime(AUTO_YES_COUNTDOWN_INTERVAL_MS);
      });

      // UI now presents as OFF and the countdown is gone.
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
      expect(screen.queryByLabelText('Time remaining')).toBeNull();
    });

    it('invokes onExpire exactly once when the countdown reaches zero', () => {
      vi.useFakeTimers();
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const onExpire = vi.fn();

      render(
        <AutoYesToggle
          {...defaultProps}
          enabled={true}
          expiresAt={now + 1000}
          onExpire={onExpire}
        />
      );

      act(() => {
        vi.setSystemTime(now + 1000);
        vi.advanceTimersByTime(AUTO_YES_COUNTDOWN_INTERVAL_MS);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);

      // Subsequent ticks must not re-fire the callback.
      act(() => {
        vi.advanceTimersByTime(AUTO_YES_COUNTDOWN_INTERVAL_MS * 3);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
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
