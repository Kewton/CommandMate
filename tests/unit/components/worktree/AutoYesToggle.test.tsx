/**
 * Tests for AutoYesToggle component - confirm dialog integration
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';

describe('AutoYesToggle', () => {
  const defaultProps = {
    enabled: false,
    expiresAt: null,
    onToggle: vi.fn().mockResolvedValue(undefined),
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

      expect(screen.getByText('Auto Yesモードを有効にしますか？')).toBeDefined();
      expect(defaultProps.onToggle).not.toHaveBeenCalled();
    });

    it('should call onToggle(true) when dialog is confirmed', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('同意して有効化'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith(true);
      });
    });

    it('should not call onToggle when dialog is cancelled', () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('キャンセル'));

      expect(defaultProps.onToggle).not.toHaveBeenCalled();
    });

    it('should close dialog after cancel', () => {
      render(<AutoYesToggle {...defaultProps} enabled={false} />);
      fireEvent.click(screen.getByRole('switch'));
      fireEvent.click(screen.getByText('キャンセル'));

      expect(screen.queryByText('Auto Yesモードを有効にしますか？')).toBeNull();
    });
  });

  describe('ON to OFF (no dialog)', () => {
    it('should call onToggle(false) directly without showing dialog', async () => {
      render(<AutoYesToggle {...defaultProps} enabled={true} />);
      fireEvent.click(screen.getByRole('switch'));

      await waitFor(() => {
        expect(defaultProps.onToggle).toHaveBeenCalledWith(false);
      });
      expect(screen.queryByText('Auto Yesモードを有効にしますか？')).toBeNull();
    });
  });
});
