/**
 * Tests for TerminalEscapeHatch (Issue #1017, C-lite safety net)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';

describe('TerminalEscapeHatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the Esc and q escape keys', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" />);
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.getByLabelText('Send q (quit)')).toBeInTheDocument();
  });

  it('sends Escape via the special-keys API', async () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" />);
    fireEvent.click(screen.getByLabelText('Send Escape'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({ cliToolId: 'codex', keys: ['Escape'] });
  });

  it('sends q and targets a non-primary instance (Issue #869)', async () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" instanceId="codex-3" />);
    fireEvent.click(screen.getByLabelText('Send q (quit)'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ cliToolId: 'codex', keys: ['q'], instanceId: 'codex-3' });
  });
});
