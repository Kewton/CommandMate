/**
 * MemoSearchBar Component Tests
 * [Issue #787] Memo text search UI
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoSearchBar } from '@/components/worktree/MemoSearchBar';

// Issue #1277: this file asserts rendered wording (aria-labels, placeholder), so
// it must resolve keys through the real dictionary. The global mock in
// tests/setup.ts echoes `<namespace>.<key>` back and would keep these assertions
// green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

function defaultProps(overrides: Partial<React.ComponentProps<typeof MemoSearchBar>> = {}) {
  return {
    query: '',
    onQueryChange: vi.fn(),
    matchCount: 0,
    currentIndex: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    ...overrides,
  };
}

describe('MemoSearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the input on mount', () => {
    render(<MemoSearchBar {...defaultProps()} />);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('renders with role="search" and aria-label', () => {
    render(<MemoSearchBar {...defaultProps()} />);
    const region = screen.getByRole('search');
    expect(region).toBeInTheDocument();
    expect(region.getAttribute('aria-label')).toBeTruthy();
  });

  it('labels the input with "Search memos"', () => {
    render(<MemoSearchBar {...defaultProps()} />);
    expect(screen.getByLabelText('Search memos')).toBeInTheDocument();
  });

  it('exposes aria-live="polite" and aria-atomic="true" for the count display', () => {
    render(<MemoSearchBar {...defaultProps({ matchCount: 3, currentIndex: 1 })} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  describe('count display', () => {
    it('shows 0/0 when no matches', () => {
      render(<MemoSearchBar {...defaultProps({ matchCount: 0 })} />);
      expect(screen.getByRole('status')).toHaveTextContent('0/0');
    });

    it('shows N/M when matches exist (currentIndex is 0-based)', () => {
      render(<MemoSearchBar {...defaultProps({ matchCount: 5, currentIndex: 2 })} />);
      expect(screen.getByRole('status')).toHaveTextContent('3/5');
    });
  });

  describe('buttons', () => {
    it('calls onNext when next button is clicked', () => {
      const onNext = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onNext, matchCount: 2, currentIndex: 0 })} />);
      fireEvent.click(screen.getByRole('button', { name: /next|次/i }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('calls onPrev when prev button is clicked', () => {
      const onPrev = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onPrev, matchCount: 2, currentIndex: 1 })} />);
      fireEvent.click(screen.getByRole('button', { name: /prev|前/i }));
      expect(onPrev).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onClose })} />);
      fireEvent.click(screen.getByRole('button', { name: /close|閉じる/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('keyboard', () => {
    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onClose })} />);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onNext when Enter is pressed', () => {
      const onNext = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onNext, matchCount: 2 })} />);
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('typing', () => {
    it('calls onQueryChange when input changes', () => {
      const onQueryChange = vi.fn();
      render(<MemoSearchBar {...defaultProps({ onQueryChange })} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
      expect(onQueryChange).toHaveBeenCalledWith('hello');
    });

    it('invokes onCompositionStart / onCompositionEnd handlers', () => {
      const onCompositionStart = vi.fn();
      const onCompositionEnd = vi.fn();
      render(
        <MemoSearchBar {...defaultProps({ onCompositionStart, onCompositionEnd })} />
      );
      const input = screen.getByRole('textbox');
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input);
      expect(onCompositionStart).toHaveBeenCalledTimes(1);
      expect(onCompositionEnd).toHaveBeenCalledTimes(1);
    });
  });
});
