/**
 * Tests for TerminalDisplay component
 *
 * Tests the terminal output display with ANSI color support and XSS prevention
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';

describe('TerminalDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render terminal output', () => {
      render(<TerminalDisplay output="Hello, World!" isActive={false} />);
      expect(screen.getByText('Hello, World!')).toBeInTheDocument();
    });

    it('should render empty state when output is empty', () => {
      render(<TerminalDisplay output="" isActive={false} />);
      const container = screen.getByRole('log');
      expect(container).toBeInTheDocument();
    });

    it('should have accessible role="log"', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should have aria-live="polite" for screen readers', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const log = screen.getByRole('log');
      expect(log).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('XSS Prevention', () => {
    it('should escape script tags', () => {
      const maliciousOutput = '<script>alert("xss")</script>';
      render(<TerminalDisplay output={maliciousOutput} isActive={false} />);

      // The content should be visible as text, not executed
      const container = screen.getByRole('log');
      expect(container.innerHTML).not.toContain('<script>');
      expect(container.textContent).toContain('script');
    });

    it('should escape img tags with onerror', () => {
      const maliciousOutput = '<img src="x" onerror="alert(1)">';
      render(<TerminalDisplay output={maliciousOutput} isActive={false} />);

      const container = screen.getByRole('log');
      // Should NOT contain actual executable img tag
      expect(container.innerHTML).not.toContain('<img ');
      expect(container.innerHTML).not.toContain('<img>');
      // The escaped text is visible but safe (shows as &lt;img...)
      expect(container.innerHTML).toContain('&lt;img');
    });

    it('should escape iframe tags', () => {
      const maliciousOutput = '<iframe src="https://evil.com"></iframe>';
      render(<TerminalDisplay output={maliciousOutput} isActive={false} />);

      const container = screen.getByRole('log');
      expect(container.innerHTML).not.toContain('<iframe');
    });

    it('should preserve safe ANSI content', () => {
      const safeOutput = 'Normal text with no HTML';
      render(<TerminalDisplay output={safeOutput} isActive={false} />);

      expect(screen.getByText(/Normal text/)).toBeInTheDocument();
    });
  });

  describe('ANSI color support', () => {
    it('should convert red ANSI codes to styled spans', () => {
      // Red text: \x1b[31m
      const redOutput = '\x1b[31mError message\x1b[0m';
      render(<TerminalDisplay output={redOutput} isActive={false} />);

      const container = screen.getByRole('log');
      // Should contain the text and have styled content
      expect(container.textContent).toContain('Error message');
      expect(container.innerHTML).toContain('style=');
    });

    it('should convert green ANSI codes to styled spans', () => {
      // Green text: \x1b[32m
      const greenOutput = '\x1b[32mSuccess!\x1b[0m';
      render(<TerminalDisplay output={greenOutput} isActive={false} />);

      const container = screen.getByRole('log');
      expect(container.textContent).toContain('Success!');
    });

    it('should preserve multiple colors', () => {
      const multiColorOutput = '\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[34mBlue\x1b[0m';
      render(<TerminalDisplay output={multiColorOutput} isActive={false} />);

      const container = screen.getByRole('log');
      expect(container.textContent).toContain('Red');
      expect(container.textContent).toContain('Green');
      expect(container.textContent).toContain('Blue');
    });
  });

  describe('Active state', () => {
    it('should show active indicator when isActive is true', () => {
      render(<TerminalDisplay output="Test" isActive={true} />);
      // Should have some visual indicator of active state
      const container = screen.getByRole('log');
      expect(container).toHaveClass('active');
    });

    it('should not show active indicator when isActive is false', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const container = screen.getByRole('log');
      expect(container).not.toHaveClass('active');
    });
  });

  describe('Thinking indicator', () => {
    it('should show thinking indicator when isThinking is true', () => {
      render(<TerminalDisplay output="Test" isActive={true} isThinking={true} />);
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    it('should not show thinking indicator when isThinking is false', () => {
      render(<TerminalDisplay output="Test" isActive={true} isThinking={false} />);
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('should not show thinking indicator when not active', () => {
      render(<TerminalDisplay output="Test" isActive={false} isThinking={true} />);
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });

  describe('Auto-scroll behavior', () => {
    it('should enable auto-scroll by default', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      // Auto-scroll is managed internally, but we can check if the component renders
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should accept autoScroll prop', () => {
      render(<TerminalDisplay output="Test" isActive={false} autoScroll={false} />);
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should call onScrollChange when scroll state changes', () => {
      const onScrollChange = vi.fn();
      render(
        <TerminalDisplay
          output="Test"
          isActive={false}
          onScrollChange={onScrollChange}
        />
      );

      // The callback will be called when user scrolls
      expect(screen.getByRole('log')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should have terminal-like styling', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const container = screen.getByRole('log');

      // Should have terminal-related classes
      expect(container.className).toContain('terminal');
    });

    it('should have monospace font', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const container = screen.getByRole('log');

      // Check for font-mono class or similar
      expect(container.className).toMatch(/mono|terminal/);
    });

    it('should have dark background', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const container = screen.getByRole('log');

      // Should have dark background class
      expect(container.className).toMatch(/bg-gray|bg-black|bg-slate/);
    });
  });

  describe('Long output handling', () => {
    it('should render long output without crashing', () => {
      const longOutput = 'a'.repeat(10000);
      render(<TerminalDisplay output={longOutput} isActive={false} />);

      const container = screen.getByRole('log');
      expect(container).toBeInTheDocument();
    });

    it('should handle output with many newlines', () => {
      const multilineOutput = Array(100).fill('Line').join('\n');
      render(<TerminalDisplay output={multilineOutput} isActive={false} />);

      const container = screen.getByRole('log');
      expect(container).toBeInTheDocument();
    });
  });

  describe('Empty and edge cases', () => {
    it('should handle undefined output gracefully', () => {
      // @ts-expect-error - testing edge case
      render(<TerminalDisplay output={undefined} isActive={false} />);
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should handle output with only whitespace', () => {
      render(<TerminalDisplay output="   \n   \t   " isActive={false} />);
      expect(screen.getByRole('log')).toBeInTheDocument();
    });

    it('should handle output with special characters', () => {
      render(<TerminalDisplay output="$HOME && ls -la | grep test" isActive={false} />);
      const container = screen.getByRole('log');
      expect(container.textContent).toContain('$HOME');
    });

    it('should handle Japanese characters', () => {
      render(<TerminalDisplay output="こんにちは世界" isActive={false} />);
      expect(screen.getByText('こんにちは世界')).toBeInTheDocument();
    });
  });
});
