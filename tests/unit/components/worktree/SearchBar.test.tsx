/**
 * SearchBar Component Tests
 * [Issue #21] File tree search functionality
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBar } from '@/components/worktree/SearchBar';

describe('SearchBar', () => {
  const defaultProps = {
    query: '',
    mode: 'name' as const,
    isSearching: false,
    onQueryChange: vi.fn(),
    onModeChange: vi.fn(),
    onClear: vi.fn(),
  };

  // ============================================================================
  // Rendering Tests
  // ============================================================================

  describe('Rendering', () => {
    it('should render search input', () => {
      render(<SearchBar {...defaultProps} />);

      expect(screen.getByTestId('search-input')).toBeInTheDocument();
    });

    it('should render mode toggle buttons', () => {
      render(<SearchBar {...defaultProps} />);

      expect(screen.getByTestId('mode-name')).toBeInTheDocument();
      expect(screen.getByTestId('mode-content')).toBeInTheDocument();
    });

    it('should display current query value', () => {
      render(<SearchBar {...defaultProps} query="test query" />);

      expect(screen.getByTestId('search-input')).toHaveValue('test query');
    });

    it('should highlight active mode button', () => {
      const { rerender } = render(<SearchBar {...defaultProps} mode="name" />);

      expect(screen.getByTestId('mode-name')).toHaveClass('bg-blue-100');
      expect(screen.getByTestId('mode-content')).not.toHaveClass('bg-blue-100');

      rerender(<SearchBar {...defaultProps} mode="content" />);

      expect(screen.getByTestId('mode-name')).not.toHaveClass('bg-blue-100');
      expect(screen.getByTestId('mode-content')).toHaveClass('bg-blue-100');
    });

    it('should use custom placeholder', () => {
      render(<SearchBar {...defaultProps} placeholder="Custom placeholder" />);

      expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Loading State Tests
  // ============================================================================

  describe('Loading State', () => {
    it('should show loading spinner when searching', () => {
      render(<SearchBar {...defaultProps} isSearching={true} />);

      expect(screen.getByTestId('search-loading')).toBeInTheDocument();
    });

    it('should not show clear button when searching', () => {
      render(<SearchBar {...defaultProps} query="test" isSearching={true} />);

      expect(screen.queryByTestId('search-clear')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Clear Button Tests
  // ============================================================================

  describe('Clear Button', () => {
    it('should show clear button when query is not empty', () => {
      render(<SearchBar {...defaultProps} query="test" />);

      expect(screen.getByTestId('search-clear')).toBeInTheDocument();
    });

    it('should not show clear button when query is empty', () => {
      render(<SearchBar {...defaultProps} query="" />);

      expect(screen.queryByTestId('search-clear')).not.toBeInTheDocument();
    });

    it('should call onClear when clear button is clicked', () => {
      const onClear = vi.fn();
      render(<SearchBar {...defaultProps} query="test" onClear={onClear} />);

      fireEvent.click(screen.getByTestId('search-clear'));

      expect(onClear).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // Input Change Tests
  // ============================================================================

  describe('Input Change', () => {
    it('should call onQueryChange when input changes', () => {
      const onQueryChange = vi.fn();
      render(<SearchBar {...defaultProps} onQueryChange={onQueryChange} />);

      fireEvent.change(screen.getByTestId('search-input'), {
        target: { value: 'hello' },
      });

      expect(onQueryChange).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // Mode Toggle Tests
  // ============================================================================

  describe('Mode Toggle', () => {
    it('should call onModeChange when name mode is clicked', () => {
      const onModeChange = vi.fn();
      render(
        <SearchBar {...defaultProps} mode="content" onModeChange={onModeChange} />
      );

      fireEvent.click(screen.getByTestId('mode-name'));

      expect(onModeChange).toHaveBeenCalledWith('name');
    });

    it('should call onModeChange when content mode is clicked', () => {
      const onModeChange = vi.fn();
      render(
        <SearchBar {...defaultProps} mode="name" onModeChange={onModeChange} />
      );

      fireEvent.click(screen.getByTestId('mode-content'));

      expect(onModeChange).toHaveBeenCalledWith('content');
    });

    it('should have correct aria-pressed attribute', () => {
      const { rerender } = render(<SearchBar {...defaultProps} mode="name" />);

      expect(screen.getByTestId('mode-name')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByTestId('mode-content')).toHaveAttribute(
        'aria-pressed',
        'false'
      );

      rerender(<SearchBar {...defaultProps} mode="content" />);

      expect(screen.getByTestId('mode-name')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      expect(screen.getByTestId('mode-content')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });
  });

  // ============================================================================
  // Keyboard Navigation Tests
  // ============================================================================

  describe('Keyboard Navigation', () => {
    it('should clear search on Escape when query is not empty', () => {
      const onClear = vi.fn();
      render(<SearchBar {...defaultProps} query="test" onClear={onClear} />);

      fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' });

      expect(onClear).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Error Display Tests
  // ============================================================================

  describe('Error Display', () => {
    it('should display error message when provided', () => {
      render(<SearchBar {...defaultProps} error="Search failed" />);

      expect(screen.getByTestId('search-error')).toBeInTheDocument();
      expect(screen.getByTestId('search-error')).toHaveTextContent('Search failed');
    });

    it('should not display error element when no error', () => {
      render(<SearchBar {...defaultProps} error={null} />);

      expect(screen.queryByTestId('search-error')).not.toBeInTheDocument();
    });

    it('should have alert role for accessibility', () => {
      render(<SearchBar {...defaultProps} error="Error message" />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Accessibility Tests
  // ============================================================================

  describe('Accessibility', () => {
    it('should have aria-label on search input', () => {
      render(<SearchBar {...defaultProps} />);

      expect(screen.getByTestId('search-input')).toHaveAttribute(
        'aria-label',
        'Search files'
      );
    });

    it('should have aria-busy when searching', () => {
      render(<SearchBar {...defaultProps} isSearching={true} />);

      expect(screen.getByTestId('search-input')).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    it('should have aria-label on clear button', () => {
      render(<SearchBar {...defaultProps} query="test" />);

      expect(screen.getByTestId('search-clear')).toHaveAttribute(
        'aria-label',
        'Clear search'
      );
    });
  });
});
