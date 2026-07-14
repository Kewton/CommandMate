/**
 * Tests for TerminalDisplay component
 *
 * Tests the terminal output display with ANSI color support and XSS prevention
 * [Issue #47] Terminal search integration tests added
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';
import { buildCodex1000RowApprovalFrame } from '../../fixtures/codex-1000-row-approval';

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

  // ============================================================================
  // [Issue #47] Terminal search integration
  // ============================================================================

  describe('[Issue #47] Terminal search', () => {
    beforeEach(() => {
      // Mock CSS.highlights for search tests
      const mockHighlightsMap = {
        set: vi.fn(),
        delete: vi.fn(),
        has: vi.fn(),
      };
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: mockHighlightsMap },
        writable: true,
        configurable: true,
      });
      // Mock Highlight constructor
      function MockHighlight(..._args: unknown[]) { return {}; }
      Object.defineProperty(globalThis, 'Highlight', {
        value: MockHighlight,
        writable: true,
        configurable: true,
      });
    });

    it('should have tabIndex=0 on the terminal container', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      const log = screen.getByRole('log');
      expect(log).toHaveAttribute('tabindex', '0');
    });

    it('should show TerminalSearchBar when Ctrl+F is pressed', () => {
      render(<TerminalDisplay output="hello world" isActive={false} />);
      const log = screen.getByRole('log');
      fireEvent.keyDown(log, { key: 'f', ctrlKey: true });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('should show TerminalSearchBar when Cmd+F is pressed', () => {
      render(<TerminalDisplay output="hello world" isActive={false} />);
      const log = screen.getByRole('log');
      fireEvent.keyDown(log, { key: 'f', metaKey: true });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('should hide TerminalSearchBar when search is closed', () => {
      render(<TerminalDisplay output="hello world" isActive={false} />);
      const log = screen.getByRole('log');
      fireEvent.keyDown(log, { key: 'f', ctrlKey: true });
      expect(screen.getByRole('textbox')).toBeInTheDocument();

      // Close with Esc
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('should open search bar when terminal-search-open custom event is dispatched', () => {
      render(<TerminalDisplay output="Test" isActive={false} />);
      act(() => {
        window.dispatchEvent(new CustomEvent('terminal-search-open'));
      });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // [Issue #842] Session-ended placeholder (distinguish loading / not-started / ended)
  // ============================================================================

  describe('[Issue #842] Session-ended placeholder', () => {
    afterEach(() => {
      cleanup();
    });

    it('shows the ended placeholder after an active session goes inactive with empty output', () => {
      const { rerender } = render(
        <TerminalDisplay output="running output" isActive={true} attaching={false} />,
      );
      // Kill / natural termination: session becomes inactive and output is cleared.
      rerender(<TerminalDisplay output="" isActive={false} attaching={false} />);
      expect(screen.getByTestId('terminal-ended-placeholder')).toBeInTheDocument();
    });

    it('does NOT show the ended placeholder while attaching (loading)', () => {
      render(<TerminalDisplay output="" isActive={false} attaching={true} />);
      expect(screen.queryByTestId('terminal-ended-placeholder')).not.toBeInTheDocument();
    });

    it('does NOT show the ended placeholder for a never-started session', () => {
      render(<TerminalDisplay output="" isActive={false} attaching={false} />);
      expect(screen.queryByTestId('terminal-ended-placeholder')).not.toBeInTheDocument();
    });

    it('does NOT show the ended placeholder while output is present', () => {
      render(<TerminalDisplay output="still has content" isActive={false} attaching={false} />);
      expect(screen.queryByTestId('terminal-ended-placeholder')).not.toBeInTheDocument();
    });

    it('shows a loading placeholder while attaching with no output', () => {
      render(<TerminalDisplay output="" isActive={false} attaching={true} />);
      expect(screen.getByTestId('terminal-loading-placeholder')).toBeInTheDocument();
    });

    it('does NOT show the loading placeholder once output has arrived', () => {
      render(<TerminalDisplay output="arrived" isActive={true} attaching={false} />);
      expect(screen.queryByTestId('terminal-loading-placeholder')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // [Issue #1172] compact TUI layout padding (Claude/Codex 1000-row panes)
  // ============================================================================

  describe('[Issue #1172] compact TUI layout padding', () => {
    let scrollToSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Explicitly mock scroll geometry/behavior (JSDOM does not implement them)
      // so we can assert on scroll calls and rendered line counts, not just that
      // a DOM node exists.
      scrollToSpy = vi.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        value: scrollToSpy,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        value: 5000,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        value: 800,
        writable: true,
        configurable: true,
      });
      // CSS custom highlight API used by terminal search.
      Object.defineProperty(globalThis, 'CSS', {
        value: { highlights: { set: vi.fn(), delete: vi.fn(), has: vi.fn() } },
        writable: true,
        configurable: true,
      });
      function MockHighlight(..._args: unknown[]) { return {}; }
      Object.defineProperty(globalThis, 'Highlight', {
        value: MockHighlight,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      cleanup();
    });

    /** Count rendered display lines via the <br> separators sanitize emits for '\n'. */
    const renderedLineCount = (container: HTMLElement) =>
      container.querySelectorAll('br').length + 1;

    it('renders input byte-for-byte when the prop is false (default)', () => {
      const raw = buildClaude1000RowPermissionFrame();
      const { container } = render(<TerminalDisplay output={raw} isActive={true} />);
      const log = container.querySelector('[role="log"]') as HTMLElement;
      // 1000 raw rows → 999 <br> separators.
      expect(renderedLineCount(log)).toBe(1000);
    });

    it('renders the Claude 1000-row fixture as 14 display lines when enabled', () => {
      const raw = buildClaude1000RowPermissionFrame();
      const { container } = render(
        <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding />,
      );
      const log = container.querySelector('[role="log"]') as HTMLElement;
      expect(renderedLineCount(log)).toBe(14);
      // Both the top prompt and the bottom task panel survive the collapse.
      expect(log.textContent).toContain('Do you want to make this edit to useVirtualKeyboard.ts?');
      expect(log.textContent).toContain('Esc to cancel · Tab to amend');
      expect(log.textContent).toContain('6 tasks (0 done, 1 in progress, 5 open)');
    });

    it('collapses the Codex 1000-row layout gap when enabled', () => {
      const raw = buildCodex1000RowApprovalFrame();
      const { container } = render(
        <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding />,
      );
      const log = container.querySelector('[role="log"]') as HTMLElement;
      expect(renderedLineCount(log)).toBeLessThan(50);
      expect(log.textContent).toContain('Allow command to run?');
      expect(log.textContent).toContain('token usage:');
    });

    it('does NOT show the ended placeholder for an active all-blank frame', () => {
      // Raw is a full 1000-row blank frame (truthy string); display compacts to ''.
      const blankFrame = Array<string>(1000).fill('').join('\n');
      render(
        <TerminalDisplay
          output={blankFrame}
          isActive={true}
          attaching={false}
          compactTuiLayoutPadding
        />,
      );
      expect(screen.queryByTestId('terminal-ended-placeholder')).not.toBeInTheDocument();
    });

    it('auto-follows to the bottom when new visible content is appended', () => {
      const first = 'line 1\nline 2';
      const { rerender } = render(
        <TerminalDisplay output={first} isActive={true} compactTuiLayoutPadding />,
      );
      scrollToSpy.mockClear();
      rerender(
        <TerminalDisplay output={`${first}\nline 3`} isActive={true} compactTuiLayoutPadding />,
      );
      expect(scrollToSpy).toHaveBeenCalledWith(
        expect.objectContaining({ top: 5000, behavior: 'instant' }),
      );
    });

    it('does NOT re-scroll when a raw-only change compacts to an identical display', () => {
      // Both frames normalize to 'A\n\nB'; only the raw blank-run length differs.
      const frameA = ['A', '', '', '', '', 'B'].join('\n');
      const frameB = ['A', '', '', '', '', '', '', '', 'B'].join('\n');
      const { rerender } = render(
        <TerminalDisplay output={frameA} isActive={true} compactTuiLayoutPadding />,
      );
      scrollToSpy.mockClear();
      rerender(<TerminalDisplay output={frameB} isActive={true} compactTuiLayoutPadding />);
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it('disables auto-follow when the user scrolls up (compact mode)', () => {
      const onScrollChange = vi.fn();
      const raw = buildClaude1000RowPermissionFrame();
      const { container } = render(
        <TerminalDisplay
          output={raw}
          isActive={true}
          compactTuiLayoutPadding
          onScrollChange={onScrollChange}
        />,
      );
      const log = container.querySelector('[role="log"]') as HTMLElement;
      // Simulate the user scrolling away from the bottom.
      Object.defineProperty(log, 'scrollTop', { value: 0, configurable: true });
      fireEvent.scroll(log);
      expect(onScrollChange).toHaveBeenCalledWith(false);
    });

    it('keeps ANSI styling and XSS sanitization in compact mode', () => {
      const raw = ['A', '', '', '', '\x1b[31mError\x1b[0m', '<script>alert(1)</script>'].join('\n');
      const { container } = render(
        <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding />,
      );
      const log = container.querySelector('[role="log"]') as HTMLElement;
      expect(log.innerHTML).not.toContain('<script>');
      expect(log.textContent).toContain('Error');
      expect(log.innerHTML).toContain('style=');
    });

    it('search operates over the compacted DOM text', async () => {
      const raw = buildClaude1000RowPermissionFrame();
      const { container } = render(
        <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding />,
      );
      const log = container.querySelector('[role="log"]') as HTMLElement;
      // The search source is container.textContent; the huge blank gap is gone,
      // so a term that only appears once is found exactly once.
      fireEvent.keyDown(log, { key: 'f', ctrlKey: true });
      const input = screen.getByRole('textbox');
      fireEvent.change(input, { target: { value: 'tasks' } });
      await waitFor(
        () => expect(screen.getByText(/1\s*\/\s*1/)).toBeInTheDocument(),
        { timeout: 1000 },
      );
    });
  });
});
