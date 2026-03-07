/**
 * Tests for TerminalSearchBar component
 * [Issue #47] Terminal search bar UI
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalSearchBar } from '@/components/worktree/TerminalSearchBar';

const defaultProps = {
  query: '',
  onQueryChange: vi.fn(),
  matchCount: 0,
  currentIndex: 0,
  onNext: vi.fn(),
  onPrev: vi.fn(),
  onClose: vi.fn(),
  isAtMaxMatches: false,
};

describe('TerminalSearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Count display
  // ============================================================================

  describe('Count display', () => {
    it('should display "0/0" when no matches', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={0} />);
      expect(screen.getByText('0/0')).toBeInTheDocument();
    });

    it('should display "3/12" correctly (1-indexed)', () => {
      render(
        <TerminalSearchBar
          {...defaultProps}
          matchCount={12}
          currentIndex={2}
        />
      );
      expect(screen.getByText('3/12')).toBeInTheDocument();
    });

    it('should display "1/5" for currentIndex=0, matchCount=5', () => {
      render(
        <TerminalSearchBar
          {...defaultProps}
          matchCount={5}
          currentIndex={0}
        />
      );
      expect(screen.getByText('1/5')).toBeInTheDocument();
    });

    it('should display "500以上" when isAtMaxMatches is true', () => {
      render(
        <TerminalSearchBar
          {...defaultProps}
          matchCount={500}
          currentIndex={0}
          isAtMaxMatches={true}
        />
      );
      expect(screen.getByText(/500以上/)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Navigation buttons
  // ============================================================================

  describe('Navigation buttons', () => {
    it('should disable prev button when matchCount is 0', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={0} />);
      expect(screen.getByLabelText('前の結果')).toBeDisabled();
    });

    it('should disable next button when matchCount is 0', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={0} />);
      expect(screen.getByLabelText('次の結果')).toBeDisabled();
    });

    it('should enable prev button when matchCount > 0', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={3} />);
      expect(screen.getByLabelText('前の結果')).not.toBeDisabled();
    });

    it('should enable next button when matchCount > 0', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={3} />);
      expect(screen.getByLabelText('次の結果')).not.toBeDisabled();
    });

    it('should call onNext when next button is clicked', () => {
      const onNext = vi.fn();
      render(<TerminalSearchBar {...defaultProps} matchCount={3} onNext={onNext} />);
      fireEvent.click(screen.getByLabelText('次の結果'));
      expect(onNext).toHaveBeenCalledOnce();
    });

    it('should call onPrev when prev button is clicked', () => {
      const onPrev = vi.fn();
      render(<TerminalSearchBar {...defaultProps} matchCount={3} onPrev={onPrev} />);
      fireEvent.click(screen.getByLabelText('前の結果'));
      expect(onPrev).toHaveBeenCalledOnce();
    });
  });

  // ============================================================================
  // Close button
  // ============================================================================

  describe('Close button', () => {
    it('should call onClose when close button is clicked', () => {
      const onClose = vi.fn();
      render(<TerminalSearchBar {...defaultProps} onClose={onClose} />);
      fireEvent.click(screen.getByLabelText('検索を閉じる'));
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // ============================================================================
  // Keyboard interactions
  // ============================================================================

  describe('Keyboard', () => {
    it('should call onClose when Escape key is pressed in input', () => {
      const onClose = vi.fn();
      render(<TerminalSearchBar {...defaultProps} onClose={onClose} />);
      const input = screen.getByRole('textbox');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  // ============================================================================
  // Input
  // ============================================================================

  describe('Input', () => {
    it('should call onQueryChange when input changes', () => {
      const onQueryChange = vi.fn();
      render(<TerminalSearchBar {...defaultProps} onQueryChange={onQueryChange} />);
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'hello' } });
      expect(onQueryChange).toHaveBeenCalledWith('hello');
    });

    it('should display the current query value', () => {
      render(<TerminalSearchBar {...defaultProps} query="test query" />);
      const input = screen.getByRole('textbox') as HTMLInputElement;
      expect(input.value).toBe('test query');
    });
  });

  // ============================================================================
  // Accessibility
  // ============================================================================

  describe('Accessibility', () => {
    it('should have aria-live region for match count', () => {
      render(<TerminalSearchBar {...defaultProps} matchCount={5} currentIndex={1} />);
      const liveRegion = screen.getByRole('status');
      expect(liveRegion).toHaveAttribute('aria-live');
    });
  });
});
