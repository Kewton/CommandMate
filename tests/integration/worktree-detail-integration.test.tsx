/**
 * Integration Tests for WorktreeDetailRefactored Component
 * @vitest-environment jsdom
 *
 * Tests the integration of all Phase 1-4 components:
 * - useWorktreeUIState (state management)
 * - useIsMobile (responsive detection)
 * - WorktreeDesktopLayout (desktop 2-column layout)
 * - TerminalDisplay (terminal output)
 * - HistoryPane (message history)
 * - PromptPanel (desktop prompt response)
 * - MobileHeader (mobile header)
 * - MobileTabBar (mobile navigation)
 * - MobilePromptSheet (mobile prompt response)
 * - ErrorBoundary (error handling)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

// Mock useIsMobile hook
const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock data
const mockWorktree = {
  id: 'test-worktree-123',
  name: 'feature/test-branch',
  path: '/path/to/worktree',
  repositoryPath: '/path/to/repo',
  repositoryName: 'TestRepo',
};

const mockMessages = [
  {
    id: 'msg-1',
    worktreeId: 'test-worktree-123',
    role: 'user' as const,
    content: 'Hello Claude',
    timestamp: new Date('2024-01-01T10:00:00').toISOString(),
    messageType: 'normal' as const,
    cliToolId: 'claude' as const,
  },
  {
    id: 'msg-2',
    worktreeId: 'test-worktree-123',
    role: 'assistant' as const,
    content: 'Hello! How can I help you today?',
    timestamp: new Date('2024-01-01T10:00:30').toISOString(),
    messageType: 'normal' as const,
    cliToolId: 'claude' as const,
  },
];

const mockTerminalOutput = 'Claude is ready.\n> Waiting for input...';

describe('WorktreeDetailRefactored Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockIsMobile.mockReturnValue(false);

    // Default mock responses
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/worktrees/') && url.includes('/messages')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockMessages),
        });
      }
      if (url.includes('/api/worktrees/') && url.includes('/current-output')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              isRunning: true,
              isGenerating: false,
              content: mockTerminalOutput,
              realtimeSnippet: '',
              thinking: false,
            }),
        });
      }
      if (url.includes('/api/worktrees/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Desktop Layout', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(false);
    });

    it('renders desktop layout with two-column grid', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });

    it('displays history pane on the left', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('left-pane')).toBeInTheDocument();
      });
    });

    it('displays terminal on the right', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('right-pane')).toBeInTheDocument();
      });
    });

    it('shows PromptPanel when prompt is active', async () => {
      // Mock prompt data in terminal output
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Do you want to continue?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
                content: mockTerminalOutput,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Mobile Layout', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
    });

    it('renders mobile layout with header and tab bar', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
        expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      });
    });

    it('displays worktree name in mobile header', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('worktree-name')).toHaveTextContent('feature/test-branch');
      });
    });

    it('switches content when tab is changed', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
      });

      // Default should be terminal tab
      const terminalTab = screen.getByRole('tab', { name: /terminal/i });
      expect(terminalTab).toHaveAttribute('aria-selected', 'true');

      // Click history tab
      const historyTab = screen.getByRole('tab', { name: /history/i });
      await act(async () => {
        fireEvent.click(historyTab);
      });

      await waitFor(() => {
        expect(historyTab).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('shows MobilePromptSheet when prompt is active', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Do you want to continue?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
                content: mockTerminalOutput,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('mobile-prompt-sheet')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('Terminal Output', () => {
    it('displays terminal output from current-output API', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        const terminalLog = screen.getByRole('log', { name: /terminal output/i });
        expect(terminalLog).toBeInTheDocument();
      });
    });

    it('shows thinking indicator when Claude is thinking', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: true,
                content: mockTerminalOutput,
                thinking: true,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );
    });
  });

  describe('History Messages', () => {
    it('displays history messages in HistoryPane', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        // Check that the message history region exists
        const historyRegion = screen.getByRole('region', { name: /message history/i });
        expect(historyRegion).toBeInTheDocument();
      });
    });

    it('renders user and assistant messages', async () => {
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        // Find messages by their text content
        expect(screen.getByText('Hello Claude')).toBeInTheDocument();
        expect(screen.getByText('Hello! How can I help you today?')).toBeInTheDocument();
      });
    });
  });

  describe('Prompt Response', () => {
    it('handles yes/no prompt response', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Do you want to continue?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
                content: mockTerminalOutput,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/prompt-response') && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );

      // Click Yes button
      const yesButton = screen.getByRole('button', { name: /yes/i });
      await act(async () => {
        fireEvent.click(yesButton);
      });

      // Verify the prompt response API was called
      await waitFor(() => {
        const promptResponseCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/prompt-response')
        );
        expect(promptResponseCall).toBeDefined();
      });
    });

    /**
     * Issue #287: Verify prompt-response request body includes promptType and defaultOptionNumber
     * for yes/no prompts.
     */
    it('includes promptType in yes/no prompt response body (Issue #287)', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                isPromptWaiting: true,
                promptData: {
                  type: 'yes_no',
                  question: 'Allow tool use?',
                  options: ['yes', 'no'],
                  status: 'pending',
                },
                content: mockTerminalOutput,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/prompt-response') && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );

      // Click Yes button
      const yesButton = screen.getByRole('button', { name: /yes/i });
      await act(async () => {
        fireEvent.click(yesButton);
      });

      // Verify the request body contains promptType
      await waitFor(() => {
        const promptResponseCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/prompt-response') && call[1]?.method === 'POST'
        );
        expect(promptResponseCall).toBeDefined();
        const body = JSON.parse(promptResponseCall![1].body as string);
        expect(body.answer).toBe('y');
        expect(body.cliTool).toBe('claude');
        expect(body.promptType).toBe('yes_no');
        // yes_no does not have defaultOptionNumber
        expect(body.defaultOptionNumber).toBeUndefined();
      });
    });

    /**
     * Issue #287: Verify prompt-response request body includes promptType and defaultOptionNumber
     * for multiple_choice prompts.
     */
    it('includes promptType and defaultOptionNumber in multiple_choice prompt response body (Issue #287)', async () => {
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('/current-output')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                isRunning: true,
                isGenerating: false,
                isPromptWaiting: true,
                promptData: {
                  type: 'multiple_choice',
                  question: 'Select an option:',
                  options: [
                    { number: 1, label: 'Option A', isDefault: true },
                    { number: 2, label: 'Option B', isDefault: false },
                    { number: 3, label: 'Option C', isDefault: false },
                  ],
                  status: 'pending',
                },
                content: mockTerminalOutput,
              }),
          });
        }
        if (url.includes('/messages')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockMessages),
          });
        }
        if (url.includes('/prompt-response') && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockWorktree),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(
        () => {
          expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
        },
        { timeout: 5000 }
      );

      // Click option 2 button
      const optionButton = screen.getByRole('button', { name: /option b/i });
      await act(async () => {
        fireEvent.click(optionButton);
      });

      // Verify the request body contains promptType and defaultOptionNumber
      await waitFor(() => {
        const promptResponseCall = mockFetch.mock.calls.find(
          (call) => call[0].includes('/prompt-response') && call[1]?.method === 'POST'
        );
        expect(promptResponseCall).toBeDefined();
        const body = JSON.parse(promptResponseCall![1].body as string);
        expect(body.answer).toBe('2');
        expect(body.cliTool).toBe('claude');
        expect(body.promptType).toBe('multiple_choice');
        expect(body.defaultOptionNumber).toBe(1);
      });
    });
  });

  describe('Error Handling', () => {
    it('displays error state when API fails', async () => {
      mockFetch.mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Internal server error' }),
        });
      });

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        // Should show error state or fallback
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });
    });

    it('gracefully handles component errors with ErrorBoundary', async () => {
      // This test verifies ErrorBoundary is wrapping components
      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        // Component should render without crashing
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('shows loading state initially', async () => {
      // Don't advance timers so fetch doesn't complete
      vi.useRealTimers();
      mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);

      // Loading indicator should be visible initially
      expect(screen.getByText(/loading/i)).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('renders desktop layout on desktop', async () => {
      mockIsMobile.mockReturnValue(false);

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
      });
    });

    it('renders mobile layout on mobile', async () => {
      mockIsMobile.mockReturnValue(true);

      await act(async () => {
        render(<WorktreeDetailRefactored worktreeId="test-worktree-123" />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
      });
    });
  });
});
