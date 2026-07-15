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
import { render, screen, act } from '@testing-library/react';

const mockIsTmuxControlModeEnabledForClient = vi.fn();

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
      return (
        <div
          data-testid="terminal-component-mock"
          data-worktree-id={props.worktreeId as string}
          data-control-mode-enabled={String(props.controlModeEnabled)}
        />
      );
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

vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabledForClient: () => mockIsTmuxControlModeEnabledForClient(),
}));

// Import the component after mocks are set up
import TerminalPage from '@/app/worktrees/[id]/terminal/page';

// Next 15 passes `params` as a Promise, which the page unwraps with `use()`.
// That suspends on first render, so render under a Suspense boundary and flush
// the promise inside act() before asserting.
const renderTerminalPage = async (id = 'test-worktree-123') => {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <React.Suspense fallback={null}>
        <TerminalPage params={Promise.resolve({ id })} />
      </React.Suspense>
    );
  });
  return result;
};

describe('TerminalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTmuxControlModeEnabledForClient.mockReturnValue(true);
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
    it('should render the terminal page with header', async () => {
      await renderTerminalPage();

      expect(screen.getByText('Back')).toBeInTheDocument();
      expect(screen.getByText(/Terminal:/)).toBeInTheDocument();
    });

    it('should render CLI tool selector buttons', async () => {
      await renderTerminalPage();

      expect(screen.getByText('Claude')).toBeInTheDocument();
      expect(screen.getByText('Codex')).toBeInTheDocument();
      expect(screen.getByText('Gemini')).toBeInTheDocument();
      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    // Issue #1044: CLI tool tabs use lucide-react icons instead of emoji literals.
    it('should render a lucide svg icon in each CLI tool button', async () => {
      await renderTerminalPage();

      for (const name of ['Claude', 'Codex', 'Gemini', 'Bash']) {
        const button = screen.getByText(name).closest('button');
        expect(button).not.toBeNull();
        expect(button!.querySelector('svg')).not.toBeNull();
      }
    });

    it('should not render emoji icon literals in CLI tool buttons', async () => {
      const { container } = await renderTerminalPage();

      for (const emoji of ['🤖', '⚡', '✦', '💻']) {
        expect(container.textContent).not.toContain(emoji);
      }
    });

    it('should render the dynamically imported TerminalComponent', async () => {
      await renderTerminalPage();

      expect(screen.getByTestId('terminal-component-mock')).toBeInTheDocument();
    });

    it('should pass worktreeId to TerminalComponent', async () => {
      await renderTerminalPage();

      const terminal = screen.getByTestId('terminal-component-mock');
      expect(terminal.getAttribute('data-worktree-id')).toBe('test-worktree-123');
    });

    it('should render status bar with terminal mode info', async () => {
      await renderTerminalPage();

      expect(screen.getByText('Control Mode')).toBeInTheDocument();
    });

    it('should pass controlModeEnabled to TerminalComponent', async () => {
      await renderTerminalPage();

      const terminal = screen.getByTestId('terminal-component-mock');
      expect(terminal.getAttribute('data-control-mode-enabled')).toBe('true');
    });

    it('should render fallback banner and status when control mode is disabled', async () => {
      mockIsTmuxControlModeEnabledForClient.mockReturnValue(false);

      await renderTerminalPage();

      expect(screen.getByText(/Tmux control mode is disabled for this client/)).toBeInTheDocument();
      expect(screen.getByText('Snapshot Fallback')).toBeInTheDocument();
    });
  });
});
