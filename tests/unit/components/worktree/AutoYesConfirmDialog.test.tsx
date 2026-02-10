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
      expect(screen.getByText('Auto Yesモードを有効にしますか？')).toBeDefined();
    });

    it('should not render dialog when isOpen is false', () => {
      render(<AutoYesConfirmDialog {...defaultProps} isOpen={false} />);
      expect(screen.queryByText('Auto Yesモードを有効にしますか？')).toBeNull();
    });

    it('should display warning text about the feature', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('機能説明')).toBeDefined();
      expect(screen.getByText(/自動で「yes」を送信/)).toBeDefined();
    });

    it('should display risk explanation', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('リスクについて')).toBeDefined();
      expect(screen.getByText(/意図しない操作/)).toBeDefined();
    });

    it('should display disclaimer text', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText(/免責事項/)).toBeDefined();
      expect(screen.getByText(/自己責任でご利用ください/)).toBeDefined();
    });

    it('should display confirm and cancel buttons', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('同意して有効化')).toBeDefined();
      expect(screen.getByText('キャンセル')).toBeDefined();
    });
  });

  describe('Duration Selection Buttons', () => {
    it('should display three duration buttons', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('1時間')).toBeDefined();
      expect(screen.getByText('3時間')).toBeDefined();
      expect(screen.getByText('8時間')).toBeDefined();
    });

    it('should have 1 hour selected by default (highlighted style)', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const btn1h = screen.getByText('1時間');
      expect(btn1h.className).toContain('border-blue-600');
    });

    it('should display "有効時間" section header', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText('有効時間')).toBeDefined();
    });

    it('should allow changing duration selection', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      const btn3h = screen.getByText('3時間');

      fireEvent.click(btn3h);
      expect(btn3h.className).toContain('border-blue-600');

      const btn1h = screen.getByText('1時間');
      expect(btn1h.className).not.toContain('border-blue-600');
    });
  });

  describe('Dynamic Text', () => {
    it('should display default duration text initially', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      expect(screen.getByText(/1時間後に自動でOFFになります/)).toBeDefined();
    });

    it('should update duration text when 3 hours is selected', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('3時間'));
      expect(screen.getByText(/3時間後に自動でOFFになります/)).toBeDefined();
    });

    it('should update duration text when 8 hours is selected', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('8時間'));
      expect(screen.getByText(/8時間後に自動でOFFになります/)).toBeDefined();
    });
  });

  describe('Interactions', () => {
    it('should call onConfirm with default duration when confirm button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('同意して有効化'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION);
    });

    it('should call onConfirm with selected 3-hour duration', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('3時間'));
      fireEvent.click(screen.getByText('同意して有効化'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(10800000);
    });

    it('should call onConfirm with selected 8-hour duration', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('8時間'));
      fireEvent.click(screen.getByText('同意して有効化'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      expect(defaultProps.onConfirm).toHaveBeenCalledWith(28800000);
    });

    it('should call onCancel when cancel button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('キャンセル'));
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
