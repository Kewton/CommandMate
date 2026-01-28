/**
 * Tests for AutoYesConfirmDialog component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesConfirmDialog } from '@/components/worktree/AutoYesConfirmDialog';

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

  describe('Interactions', () => {
    it('should call onConfirm when confirm button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('同意して有効化'));
      expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when cancel button is clicked', () => {
      render(<AutoYesConfirmDialog {...defaultProps} />);
      fireEvent.click(screen.getByText('キャンセル'));
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
