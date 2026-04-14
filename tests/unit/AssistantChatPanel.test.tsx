/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantChatPanel } from '@/components/home/AssistantChatPanel';
import { assistantApi } from '@/lib/api/assistant-api';

vi.mock('@/lib/api/assistant-api', () => ({
  assistantApi: {
    getInstalledTools: vi.fn(),
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
          { path: '/repos/alpha', name: 'alpha', displayName: 'Alpha Repo' },
        ],
      }),
    } as Response);

    vi.mocked(assistantApi.getInstalledTools).mockResolvedValue([
      { id: 'claude', name: 'Claude Code', installed: true },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a dark background treatment for the panel shell', () => {
    render(<AssistantChatPanel />);

    expect(screen.getByTestId('assistant-chat-panel')).toHaveClass('bg-slate-950/95');
    expect(screen.getByTestId('assistant-toggle-button')).toHaveClass('bg-slate-900/90');
  });

  it('explains what the repository selector controls', async () => {
    render(<AssistantChatPanel />);

    fireEvent.click(screen.getByTestId('assistant-toggle-button'));

    expect(
      await screen.findByText(
        'Start a local assistant session in a repository and chat from that working directory.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Repository to Work In')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The repository selection sets where the assistant starts running commands and reading files.',
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Start directory: Alpha Repo')).toBeInTheDocument();
    });
  });

  it('shows a clearer empty-state prompt before the session starts', async () => {
    render(<AssistantChatPanel />);

    fireEvent.click(screen.getByTestId('assistant-toggle-button'));

    expect(
      await screen.findByText('Select a repository and click Start to open an assistant session.'),
    ).toBeInTheDocument();
  });
});
