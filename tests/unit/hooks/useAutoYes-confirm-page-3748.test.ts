/**
 * @vitest-environment jsdom
 *
 * Issue #3748: the browser's Auto-Yes fallback (`useAutoYes`, which answers only
 * while no server poller runs) leaves the `AskUserQuestion` confirm page to a
 * human, judged by the predicate the server's poller uses
 * (`polling/auto-yes-confirm-page`).
 *
 * 陽性: Claude's `❯ 1. Submit answers` / `2. Cancel` page and Command Code's
 * `❯ 1. Submit` / `2. Cancel` page — no request. Before #3748 the hook posted
 * `1` to both. 陰性: an ordinary yes/no prompt, Claude's ordinary permission
 * dialog, and a hook given no frame are answered as before.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoYes } from '@/hooks/useAutoYes';
import type { PromptData } from '@/types/models';
import { COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME } from '@tests/fixtures/command-code-askuserquestion-3497/free-text-confirm';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const CLAUDE_REVIEW = readFileSync(
  path.resolve(__dirname, '../../fixtures/claude-live-2486/tabs-preview-review.txt'),
  'utf8',
);
const CLAUDE_BASH_APPROVAL = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
  'utf8',
);

function submitCancel(submitLabel: string): PromptData {
  return {
    type: 'multiple_choice',
    question: 'Ready to submit your answers?',
    options: [
      { number: 1, label: submitLabel, isDefault: true },
      { number: 2, label: 'Cancel', isDefault: false },
    ],
    status: 'pending',
  };
}

function render(cliTool: string, promptData: PromptData, frame?: string | null): void {
  renderHook(() =>
    useAutoYes({
      worktreeId: 'wt-3748',
      cliTool,
      isPromptWaiting: true,
      promptData,
      autoYesEnabled: true,
      serverPollerActive: false,
      frame,
    }),
  );
}

describe('useAutoYes - AskUserQuestion confirm page (Issue #3748)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('claude: does not post Submit answers while no server poller runs', () => {
    render('claude', submitCancel('Submit answers'), CLAUDE_REVIEW);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('command-code: does not post Submit while no server poller runs', () => {
    render('command-code', submitCancel('Submit'), COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('陰性: Claude’s ordinary permission dialog is answered `1`', () => {
    const promptData: PromptData = {
      type: 'multiple_choice',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes', isDefault: true },
        { number: 2, label: 'No', isDefault: false },
      ],
      status: 'pending',
    };
    render('claude', promptData, CLAUDE_BASH_APPROVAL);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).answer).toBe('1');
  });

  it('陰性: a yes/no prompt is answered `y`', () => {
    const promptData: PromptData = {
      type: 'yes_no',
      question: 'Continue?',
      options: ['yes', 'no'],
      status: 'pending',
    };
    render('claude', promptData, 'Working.\n\nContinue? (y/n)\n');
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).answer).toBe('y');
  });

  it('陰性: Claude’s confirm page under another tool is not judged as one', () => {
    render('codex', submitCancel('Submit answers'), CLAUDE_REVIEW);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('陰性: no frame, nothing judged — answered as before', () => {
    render('claude', submitCancel('Submit answers'), null);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
