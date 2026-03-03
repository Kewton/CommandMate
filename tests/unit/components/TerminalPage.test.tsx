/**
 * TerminalPage Component Tests
 *
 * Tests for the terminal page component including:
 * - Dynamic import of TerminalComponent with ssr: false
 * - Loading indicator display during dynamic import
 * - Page header and navigation rendering
 *
 * Issue #410: xterm.js dynamic import optimization
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Use a module-scoped variable that vi.mock can access via closure
// vi.mock is hoisted, so we use vi.hoisted() to ensure the variable is available
const { dynamicCalls } = vi.hoisted(() => {
  const dynamicCalls: Array<{
    loader: unknown;
    options: { ssr?: boolean; loading?: () => React.ReactElement };
  }> = [];
  return { dynamicCalls };
});

// Mock next/dynamic to capture configuration and render a stub
vi.mock('next/dynamic', () => ({
  default: (
    loader: () => Promise<unknown>,
    options?: { ssr?: boolean; loading?: () => React.ReactElement }
  ) => {
    dynamicCalls.push({ loader, options: options || {} });
    // Return a stub component that renders with data-testid
    const DynamicComponent = (props: Record<string, unknown>) => {
      return <div data-testid="terminal-component-mock" data-worktree-id={props.worktreeId as string} />;
    };
    return DynamicComponent;
  },
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Import the component after mocks are set up
import TerminalPage from '@/app/worktrees/[id]/terminal/page';

describe('TerminalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Dynamic Import Configuration', () => {
    it('should use next/dynamic with ssr: false for TerminalComponent', () => {
      // The dynamic() call happens at module load time
      expect(dynamicCalls.length).toBeGreaterThanOrEqual(1);
      const terminalCall = dynamicCalls[0];
      expect(terminalCall.options.ssr).toBe(false);
    });

    it('should provide a loading component for TerminalComponent', () => {
      const terminalCall = dynamicCalls[0];
      expect(terminalCall.options.loading).toBeDefined();
      expect(typeof terminalCall.options.loading).toBe('function');
    });

    it('should render loading indicator with terminal theme (bg-gray-900)', () => {
      const terminalCall = dynamicCalls[0];
      const LoadingComponent = terminalCall.options.loading!;
      const { container } = render(<LoadingComponent />);

      // Verify terminal-themed loading indicator
      const loadingDiv = container.firstChild as HTMLElement;
      expect(loadingDiv.className).toContain('bg-gray-900');
    });

    it('should render Loader2 spinner in loading indicator', () => {
      const terminalCall = dynamicCalls[0];
      const LoadingComponent = terminalCall.options.loading!;
      const { container } = render(<LoadingComponent />);

      // Check for animate-spin class (Loader2 spinner)
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).not.toBeNull();
    });

    it('should display "Loading terminal..." text in loading indicator', () => {
      const terminalCall = dynamicCalls[0];
      const LoadingComponent = terminalCall.options.loading!;
      render(<LoadingComponent />);

      expect(screen.getByText('Loading terminal...')).toBeInTheDocument();
    });
  });

  describe('Page Rendering', () => {
    it('should render the terminal page with header', () => {
      render(<TerminalPage params={{ id: 'test-worktree-123' }} />);

      expect(screen.getByText('Back')).toBeInTheDocument();
      expect(screen.getByText(/Terminal:/)).toBeInTheDocument();
    });

    it('should render CLI tool selector buttons', () => {
      render(<TerminalPage params={{ id: 'test-worktree-123' }} />);

      expect(screen.getByText('Claude')).toBeInTheDocument();
      expect(screen.getByText('Codex')).toBeInTheDocument();
      expect(screen.getByText('Gemini')).toBeInTheDocument();
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    it('should render the dynamically imported TerminalComponent', () => {
      render(<TerminalPage params={{ id: 'test-worktree-123' }} />);

      expect(screen.getByTestId('terminal-component-mock')).toBeInTheDocument();
    });

    it('should pass worktreeId to TerminalComponent', () => {
      render(<TerminalPage params={{ id: 'test-worktree-123' }} />);

      const terminal = screen.getByTestId('terminal-component-mock');
      expect(terminal.getAttribute('data-worktree-id')).toBe('test-worktree-123');
    });

    it('should render status bar with terminal mode info', () => {
      render(<TerminalPage params={{ id: 'test-worktree-123' }} />);

      expect(screen.getByText('Terminal Mode')).toBeInTheDocument();
    });
  });
});
