/**
 * @vitest-environment jsdom
 *
 * Issue #287: Tests for useAutoYes hook
 * Validated that the hook included promptType and defaultOptionNumber
 * in the prompt-response API request body.
 *
 * Issue #3821: the browser no longer answers. Every case below that sent an
 * answer now asserts that nothing is sent — with Auto-Yes on, a prompt the
 * base rules would answer, and no server poller (`serverPollerActive` absent,
 * the one condition under which the hook used to send) — and that nothing is
 * announced (`lastAutoResponse` stays null).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutoYes } from '@/hooks/useAutoYes';
import type { PromptData } from '@/types/models';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useAutoYes - promptType/defaultOptionNumber in request body (Issue #287)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[#3821] sends nothing for a yes/no prompt (was: promptType=yes_no in the body)', () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData,
        autoYesEnabled: true,
      })
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[#3821] sends nothing for a multiple choice with a default (was: promptType and defaultOptionNumber)', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'First', isDefault: false },
        { number: 2, label: 'Second', isDefault: true },
        { number: 3, label: 'Third', isDefault: false },
      ],
      status: 'pending',
    };

    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData,
        autoYesEnabled: true,
      })
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[#3821] sends nothing for a multiple choice without a default', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Choose:',
      options: [
        { number: 1, label: 'First', isDefault: false },
        { number: 2, label: 'Second', isDefault: false },
      ],
      status: 'pending',
    };

    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData,
        autoYesEnabled: true,
      })
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not send request when autoYesEnabled is false', () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData,
        autoYesEnabled: false,
      })
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[#3821] sends nothing on a re-render of the same prompt either', () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    const { rerender } = renderHook(
      (props) => useAutoYes(props),
      {
        initialProps: {
          worktreeId: 'wt-1',
          cliTool: 'claude',
          isPromptWaiting: true,
          promptData,
          autoYesEnabled: true,
        },
      }
    );

    expect(mockFetch).not.toHaveBeenCalled();

    // Re-render with same prompt data
    rerender({
      worktreeId: 'wt-1',
      cliTool: 'claude',
      isPromptWaiting: true,
      promptData,
      autoYesEnabled: true,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[#3821] lastAutoResponse stays null, before and after the prompt clears', async () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };

    const { result, rerender } = renderHook(
      (props) => useAutoYes(props),
      {
        initialProps: {
          worktreeId: 'wt-1',
          cliTool: 'claude',
          isPromptWaiting: true,
          promptData: promptData as PromptData | null,
          autoYesEnabled: true,
        },
      }
    );

    expect(result.current.lastAutoResponse).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.lastAutoResponse).toBeNull();

    // Clear prompt
    rerender({
      worktreeId: 'wt-1',
      cliTool: 'claude',
      isPromptWaiting: false,
      promptData: null,
      autoYesEnabled: true,
    });

    expect(result.current.lastAutoResponse).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('[#3821] Auto-Yes on, a readable question and no server poller: nothing is sent (was the one case the hook answered)', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Which framework?',
      options: [
        { number: 1, label: 'React', isDefault: true },
        { number: 2, label: 'Vue', isDefault: false },
      ],
      status: 'pending',
    };
    const { result } = renderHook(() =>
      useAutoYes({
        worktreeId: 'wt-1',
        cliTool: 'claude',
        isPromptWaiting: true,
        promptData,
        autoYesEnabled: true,
        serverPollerActive: false,
        lastServerResponseTimestamp: null,
      })
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.lastAutoResponse).toBeNull();
  });
});
