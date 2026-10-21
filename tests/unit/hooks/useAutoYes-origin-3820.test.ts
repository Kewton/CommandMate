/**
 * @vitest-environment jsdom
 *
 * Issue #3820: the browser's Auto-Yes says so in its `/prompt-response` body
 * (`origin: 'auto-yes-browser'`), so the server's ledger can count it apart
 * from a person's answer. Nothing else in the body changes, and a person's
 * answer — built by the same builder — carries no origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoYes } from '@/hooks/useAutoYes';
import { AUTO_YES_BROWSER_ORIGIN, buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import type { PromptData } from '@/types/models';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const PROMPT: PromptData = {
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', isDefault: true, requiresTextInput: false },
    { number: 2, label: 'No', isDefault: false, requiresTextInput: false },
  ],
  status: 'pending',
};

describe('[#3820] the browser Auto-Yes’s origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is on the body it posts, beside what the body always carried', () => {
    renderHook(() =>
      useAutoYes({ worktreeId: 'wt-1', cliTool: 'claude', isPromptWaiting: true, promptData: PROMPT, autoYesEnabled: true })
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ ...buildPromptResponseBody('1', 'claude', PROMPT), origin: AUTO_YES_BROWSER_ORIGIN });
    expect(body.origin).toBe('auto-yes-browser');
  });

  it('is not on the body a person’s answer is built with', () => {
    expect(buildPromptResponseBody('1', 'claude', PROMPT)).not.toHaveProperty('origin');
  });
});
