/**
 * Tests for AutoYesConfirmDialog component
 *
 * Issue #225: Updated for duration selection feature
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesConfirmDialog } from '@/components/worktree/AutoYesConfirmDialog';
import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config';

describe('AutoYesConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render dialog when isOpen is true', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.enableTitle')).toBeDefined();
    });

    it('should not render dialog when isOpen is false', () => {
      render(<AutoYesConfirmDialog {...defaultProps} isOpen={false} />);
      expect(screen.queryByText('autoYes.enableTitle')).toBeNull();
    });

    it('should display warning text about the feature', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.featureDescription')).toBeDefined();
      expect(screen.getByText('autoYes.yesNoAutoResponse')).toBeDefined();
    });

    it('should display risk explanation', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.aboutRisks')).toBeDefined();
      expect(screen.getByText('autoYes.riskWarning')).toBeDefined();
    });

    it('should display disclaimer text', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.disclaimer')).toBeDefined();
      expect(screen.getByText('autoYes.disclaimerText')).toBeDefined();
    });

    it('should display confirm and cancel buttons', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.agreeAndEnable')).toBeDefined();
      expect(screen.getByText('common.cancel')).toBeDefined();
    });
  });

  describe('Duration Selection Buttons', () => {
    it('should display three duration buttons', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.durations.1h')).toBeDefined();
      expect(screen.getByText('autoYes.durations.3h')).toBeDefined();
      expect(screen.getByText('autoYes.durations.8h')).toBeDefined();
    });

    it('should have 1 hour selected by default (highlighted style)', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const btn1h = screen.getByText('autoYes.durations.1h');
      expect(btn1h.className).toContain('border-blue-600');
    });

    it('should display "有効時間" section header', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('autoYes.duration')).toBeDefined();
    });

    it('should allow changing duration selection', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const btn3h = screen.getByText('autoYes.durations.3h');

      fireEvent.click(btn3h);
      expect(btn3h.className).toContain('border-blue-600');

      const btn1h = screen.getByText('autoYes.durations.1h');
      expect(btn1h.className).not.toContain('border-blue-600');
    });
  });

  describe('Dynamic Text', () => {
    it('should display default duration text initially', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText(/autoYes\.autoDisableAfter/)).toBeDefined();
    });

    it('should update duration text when 3 hours is selected', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.durations.3h'));
      expect(screen.getByText(/autoYes\.autoDisableAfter/)).toBeDefined();
    });

    it('should update duration text when 8 hours is selected', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.durations.8h'));
      expect(screen.getByText(/autoYes\.autoDisableAfter/)).toBeDefined();
    });
  });

  describe('Interactions', () => {
    it('should call onConfirm with default duration when confirm button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, undefined);
    });

    it('should call onConfirm with selected 3-hour duration', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.durations.3h'));
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(10800000, undefined);
    });

    it('should call onConfirm with selected 8-hour duration', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.durations.8h'));
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(28800000, undefined);
    });

    it('should call onCancel when cancel button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('common.cancel'));
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Issue #314: Stop Pattern Tests
  // ==========================================================================
  describe('Stop Pattern (Issue #314)', () => {
    it('should display stop pattern input field', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByTestId('stop-pattern-input')).toBeDefined();
      expect(screen.getByText('autoYes.stopPatternLabel')).toBeDefined();
      expect(screen.getByText('autoYes.stopPatternDescription')).toBeDefined();
    });

    it('should call onConfirm with stopPattern when valid pattern is entered', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const input = screen.getByTestId('stop-pattern-input');
      fireEvent.change(input, { target: { value: 'error|fatal' } });
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, 'error|fatal');
    });

    it('should call onConfirm with undefined stopPattern when input is empty', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, undefined);
    });

    it('should call onConfirm with undefined when input is only whitespace', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const input = screen.getByTestId('stop-pattern-input');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));

      expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, undefined);
    });

    it('should show validation error for invalid regex and disable confirm button', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const input = screen.getByTestId('stop-pattern-input');
      fireEvent.change(input, { target: { value: '[invalid' } });

      // Error should be displayed
      expect(screen.getByTestId('stop-pattern-error')).toBeDefined();

      // Confirm button should be disabled
      const confirmButton = screen.getByTestId('confirm-button');
      expect(confirmButton).toHaveProperty('disabled', true);
    });

    it('should clear error when input is corrected', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const input = screen.getByTestId('stop-pattern-input');

      // Enter invalid pattern
      fireEvent.change(input, { target: { value: '[invalid' } });
      expect(screen.getByTestId('stop-pattern-error')).toBeDefined();

      // Correct the pattern
      fireEvent.change(input, { target: { value: 'valid' } });
      expect(screen.queryByTestId('stop-pattern-error')).toBeNull();
    });

    it('should reset stopPattern when dialog reopens', () => {
      const { rerender } = render(<AutoYesConfirmDialog {...defaultProps} />);
      const input = screen.getByTestId('stop-pattern-input');
      fireEvent.change(input, { target: { value: 'some-pattern' } });

      // Close dialog
      rerender(<AutoYesConfirmDialog {...defaultProps} isOpen={false} />);

      // Reopen dialog
      rerender(<AutoYesConfirmDialog {...defaultProps} isOpen={true} />);

      // Input should be cleared
      const resetInput = screen.getByTestId('stop-pattern-input') as HTMLInputElement;
      expect(resetInput.value).toBe('');
    });
  });
});
