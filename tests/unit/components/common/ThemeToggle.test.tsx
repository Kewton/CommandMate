/**
 * Tests for ThemeToggle component
 *
 * Issue #424: Dark Modern UI support
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock next-themes
const mockSetTheme = vi.fn();
let mockTheme = 'dark';

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
  }),
}));

import { ThemeToggle } from '@/components/common/ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = 'dark';
  });

  describe('Rendering', () => {
    it('should render a placeholder before mount, then the toggle button after mount', () => {
      render(<ThemeToggle />);
      // After useEffect runs (synchronously in test environment), the real button should appear
      const toggle = screen.getByTestId('theme-toggle');
      expect(toggle).toBeInTheDocument();
    });

    it('should render as a button element', () => {
      render(<ThemeToggle />);
      const toggle = screen.getByTestId('theme-toggle');
      expect(toggle.tagName).toBe('BUTTON');
    });
  });

  describe('Dark mode', () => {
    it('should show Sun icon in dark mode', () => {
      mockTheme = 'dark';
      render(<ThemeToggle />);
      expect(screen.getByTestId('theme-icon-sun')).toBeInTheDocument();
    });

    it('should have correct aria-label in dark mode', () => {
      mockTheme = 'dark';
      render(<ThemeToggle />);
      const toggle = screen.getByTestId('theme-toggle');
      expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');
    });

    it('should switch to light mode when clicked in dark mode', () => {
      mockTheme = 'dark';
      render(<ThemeToggle />);
      fireEvent.click(screen.getByTestId('theme-toggle'));
      expect(mockSetTheme).toHaveBeenCalledWith('light');
    });
  });

  describe('Light mode', () => {
    it('should show Moon icon in light mode', () => {
      mockTheme = 'light';
      render(<ThemeToggle />);
      expect(screen.getByTestId('theme-icon-moon')).toBeInTheDocument();
    });

    it('should have correct aria-label in light mode', () => {
      mockTheme = 'light';
      render(<ThemeToggle />);
      const toggle = screen.getByTestId('theme-toggle');
      expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
    });

    it('should switch to dark mode when clicked in light mode', () => {
      mockTheme = 'light';
      render(<ThemeToggle />);
      fireEvent.click(screen.getByTestId('theme-toggle'));
      expect(mockSetTheme).toHaveBeenCalledWith('dark');
    });
  });

  describe('Styling', () => {
    it('should have focus ring with cyan color', () => {
      render(<ThemeToggle />);
      const toggle = screen.getByTestId('theme-toggle');
      expect(toggle.className).toContain('focus:ring-cyan-500');
    });
  });
});
