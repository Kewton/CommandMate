/**
 * Tests for TerminalEscapeHatch (Issue #1017 safety net, extended to a
 * detection-independent navigation pad in Issue #1494).
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

  // Issue #1494: the hatch is the on-screen way to drive an unclassified overlay
  // (e.g. Claude `/help`) where NavigationButtons is not rendered, so it must
  // expose the arrow / Enter keys, not just Esc.
  it('renders the arrow, Enter and Escape navigation keys (Issue #1494)', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByLabelText('Send Left')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Down')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Right')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Enter')).toBeInTheDocument();
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
  });

  it('renders the Esc and q keys for Codex', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" />);
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.getByLabelText('Send q (quit)')).toBeInTheDocument();
  });

  it('exposes q only for Codex so it cannot reach another CLI input prompt', () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);
    expect(screen.getByLabelText('Send Escape')).toBeInTheDocument();
    expect(screen.queryByLabelText('Send q (quit)')).not.toBeInTheDocument();
  });

  it.each([
    ['Send Left', 'Left'],
    ['Send Right', 'Right'],
    ['Send Enter', 'Enter'],
    ['Send Escape', 'Escape'],
  ])('sends %s via the special-keys API as key %s (Issue #1494)', async (ariaLabel, expectedKey) => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="claude" />);
    fireEvent.click(screen.getByLabelText(ariaLabel));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      cliToolId: 'claude',
      keys: [expectedKey],
    });
  });

  it('sends q and targets a non-primary instance (Issue #869)', async () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" instanceId="codex-3" />);
    fireEvent.click(screen.getByLabelText('Send q (quit)'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ cliToolId: 'codex', keys: ['q'], instanceId: 'codex-3' });
  });
});
