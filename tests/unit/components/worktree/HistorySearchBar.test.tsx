/**
 * HistorySearchBar Component Tests
 * [Issue #716] History text search UI
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistorySearchBar } from '@/components/worktree/HistorySearchBar';

// Issue #1276: this bar shipped hardcoded Japanese, so its labels are now
// dictionary-driven. The global mock would echo `worktree.history.search.next`
// and every name-based query below would pass while resolving nothing — back it
// with the real dictionary instead. Default locale is ja so the pre-migration
// Japanese assertions keep their original meaning.
const locale = vi.hoisted(() => ({ current: 'ja' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

function defaultProps(overrides: Partial<React.ComponentProps<typeof HistorySearchBar>> = {}) {
  return {
    query: '',
    onQueryChange: vi.fn(),
    matchCount: 0,
    currentIndex: 0,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    isAtMaxMatches: false,
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    ...overrides,
  };
}

describe('HistorySearchBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    locale.current = 'ja';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses the input on mount', () => {
    render(<HistorySearchBar {...defaultProps()} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
  });

  it('renders with role="search" and aria-label', () => {
    render(<HistorySearchBar {...defaultProps()} />);
    const region = screen.getByRole('search');
    expect(region).toBeInTheDocument();
    expect(region.getAttribute('aria-label')).toBeTruthy();
  });

  it('exposes aria-live="polite" and aria-atomic="true" for the count display', () => {
    render(<HistorySearchBar {...defaultProps({ matchCount: 3, currentIndex: 1 })} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  describe('count display', () => {
    it('shows 0/0 when no matches', () => {
      render(<HistorySearchBar {...defaultProps({ matchCount: 0 })} />);
      expect(screen.getByRole('status')).toHaveTextContent('0/0');
    });

    it('shows N/M when matches exist', () => {
      render(<HistorySearchBar {...defaultProps({ matchCount: 5, currentIndex: 2 })} />);
      // currentIndex is 0-based; display should be 3/5.
      expect(screen.getByRole('status')).toHaveTextContent('3/5');
    });

    it('shows N/500以上 when at max matches', () => {
      render(
        <HistorySearchBar
          {...defaultProps({ matchCount: 500, currentIndex: 0, isAtMaxMatches: true })}
        />
      );
      expect(screen.getByRole('status').textContent).toMatch(/500以上/);
    });

    it('shows the localized at-max count in en', () => {
      locale.current = 'en';
      render(
        <HistorySearchBar
          {...defaultProps({ matchCount: 500, currentIndex: 0, isAtMaxMatches: true })}
        />
      );
      expect(screen.getByRole('status').textContent).toMatch(/1\/500\+/);
    });
  });

  /**
   * Issue #1276: the bar rendered Japanese regardless of locale before the
   * migration. These pin the actual rendered wording per locale — the assertion
   * the echoing global mock could never make.
   */
  describe('localization (Issue #1276)', () => {
    it('renders Japanese labels under the ja locale', () => {
      render(<HistorySearchBar {...defaultProps()} />);
      expect(screen.getByRole('search')).toHaveAttribute('aria-label', '履歴内テキスト検索');
      expect(screen.getByPlaceholderText('検索...')).toBeInTheDocument();
    });

    it('renders English labels under the en locale', () => {
      locale.current = 'en';
      render(<HistorySearchBar {...defaultProps()} />);
      expect(screen.getByRole('search')).toHaveAttribute('aria-label', 'Search history text');
      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    });
  });

  describe('Esc key', () => {
    it('calls onClose when Escape is pressed on input', () => {
      const onClose = vi.fn();
      render(<HistorySearchBar {...defaultProps({ onClose })} />);
      const input = screen.getByRole('textbox');
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('buttons', () => {
    it('calls onNext when next button is clicked', () => {
      const onNext = vi.fn();
      render(<HistorySearchBar {...defaultProps({ onNext, matchCount: 2, currentIndex: 0 })} />);
      const nextBtn = screen.getByRole('button', { name: /next|次/i });
      fireEvent.click(nextBtn);
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('calls onPrev when prev button is clicked', () => {
      const onPrev = vi.fn();
      render(<HistorySearchBar {...defaultProps({ onPrev, matchCount: 2, currentIndex: 1 })} />);
      const prevBtn = screen.getByRole('button', { name: /prev|前/i });
      fireEvent.click(prevBtn);
      expect(onPrev).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      render(<HistorySearchBar {...defaultProps({ onClose })} />);
      const closeBtn = screen.getByRole('button', { name: /close|閉じる/i });
      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('typing', () => {
    it('calls onQueryChange when input changes', () => {
      const onQueryChange = vi.fn();
      render(<HistorySearchBar {...defaultProps({ onQueryChange })} />);
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'hello' } });
      expect(onQueryChange).toHaveBeenCalledWith('hello');
    });

    it('invokes onCompositionStart / onCompositionEnd handlers', () => {
      const onCompositionStart = vi.fn();
      const onCompositionEnd = vi.fn();
      render(
        <HistorySearchBar
          {...defaultProps({ onCompositionStart, onCompositionEnd })}
        />
      );
      const input = screen.getByRole('textbox');
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input);
      expect(onCompositionStart).toHaveBeenCalledTimes(1);
      expect(onCompositionEnd).toHaveBeenCalledTimes(1);
    });
  });
});
