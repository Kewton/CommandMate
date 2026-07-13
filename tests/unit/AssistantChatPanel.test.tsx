/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AssistantChatPanel } from '@/components/home/AssistantChatPanel';
import { assistantApi } from '@/lib/api/assistant-api';

vi.mock('@/lib/api/assistant-api', () => ({
  assistantApi: {
    getInstalledTools: vi.fn(),
    getConversation: vi.fn(),
    getMessages: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    sendCommand: vi.fn(),
    getCurrentOutput: vi.fn(),
  },
}));

const mockFetch = vi.fn();

describe('AssistantChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    global.fetch = mockFetch as typeof fetch;

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        repositories: [
          {
            id: 'repo-1',
            path: '/repos/alpha',
            name: 'alpha',
            displayName: 'Alpha Repo',
          },
        ],
      }),
    } as Response);

    vi.mocked(assistantApi.getInstalledTools).mockResolvedValue([
      { id: 'claude', name: 'Claude Code', installed: true },
    ]);
    vi.mocked(assistantApi.getConversation).mockResolvedValue(null);
    vi.mocked(assistantApi.getMessages).mockResolvedValue([]);
    vi.mocked(assistantApi.getCurrentOutput).mockResolvedValue({
      output: '',
      sessionActive: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a theme-following elevated surface for the panel shell (Issue #1075)', () => {
    render(<AssistantChatPanel />);

    // Panel shell is now a Card(variant=elevated): surface tokens flip with the
    // active theme instead of the previous always-dark slate treatment.
    const panel = screen.getByTestId('assistant-chat-panel');
    expect(panel).toHaveClass('from-surface');
    expect(panel).not.toHaveClass('bg-slate-950/95');
  });

  it('shows repository selector and start directory hint', async () => {
    render(<AssistantChatPanel />);

    expect(await screen.findByText('Repository to Work In')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Start directory: Alpha Repo (/repos/alpha)')).toBeInTheDocument();
    });
  });

  it('shows a clearer empty-state prompt before the session starts', async () => {
    render(<AssistantChatPanel />);

    expect(
      await screen.findByText('Select a repository and click Start to open an assistant session.'),
    ).toBeInTheDocument();
  });
});
