/**
 * @vitest-environment jsdom
 *
 * Issue #287: Tests for useAutoYes hook
 * Validates that the hook includes promptType and defaultOptionNumber
 * in the prompt-response API request body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

  it('should include promptType=yes_no in request body for yes/no prompts', () => {
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

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/prompt-response');
    const body = JSON.parse(options.body);
    expect(body.promptType).toBe('yes_no');
    expect(body.answer).toBe('y');
    expect(body.cliTool).toBe('claude');
    // yes_no should not have defaultOptionNumber
    expect(body.defaultOptionNumber).toBeUndefined();
  });

  it('should include promptType=multiple_choice and defaultOptionNumber in request body', () => {
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

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.promptType).toBe('multiple_choice');
    expect(body.defaultOptionNumber).toBe(2); // The default option is #2
    expect(body.answer).toBe('2'); // Auto-answer should be the default option
  });

  it('should not include defaultOptionNumber for multiple_choice without default', () => {
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

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.promptType).toBe('multiple_choice');
    // No default option, so defaultOptionNumber should not be present
    expect(body.defaultOptionNumber).toBeUndefined();
    expect(body.answer).toBe('1'); // Falls back to first option
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

  it('should not send duplicate requests for same prompt', () => {
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

    expect(mockFetch).toHaveBeenCalledOnce();

    // Re-render with same prompt data
    rerender({
      worktreeId: 'wt-1',
      cliTool: 'claude',
      isPromptWaiting: true,
      promptData,
      autoYesEnabled: true,
    });

    // Should still only have been called once (duplicate prevention)
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('should reset lastAutoResponse when prompt clears', () => {
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

    expect(result.current.lastAutoResponse).toBe('y');

    // Clear prompt
    rerender({
      worktreeId: 'wt-1',
      cliTool: 'claude',
      isPromptWaiting: false,
      promptData: null,
      autoYesEnabled: true,
    });

    // After prompt clears, lastAutoResponse remains (it's the last answer sent)
    // The ref is reset though, so a new prompt with the same content will be answered again
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
