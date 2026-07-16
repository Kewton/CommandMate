/**
 * Tests for NavigationButtons (Issue #473, #1017)
 *
 * Focus: the Issue #1017 pager key set (PgUp/PgDn/Home/End/q) is appended only
 * when showPagerKeys is set, and clicking a key POSTs it to the special-keys API.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';

// Issue #1277: this file asserts rendered wording (the "Nav" caption, the
// toolbar aria-label, "Quit pager"), so it must resolve keys through the real
// dictionary. The global mock in tests/setup.ts echoes `<namespace>.<key>` back
// and would keep these assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('NavigationButtons', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders only the base arrow/Enter/Esc buttons by default', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" />);
    expect(screen.getByLabelText('Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Escape')).toBeInTheDocument();
    // Pager keys absent.
    expect(screen.queryByLabelText('Page Up')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Quit pager')).not.toBeInTheDocument();
  });

  it('appends the pager keys (PgUp/PgDn/Home/End/q) when showPagerKeys is set (Issue #1017)', () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" showPagerKeys />);
    expect(screen.getByLabelText('Page Up')).toBeInTheDocument();
    expect(screen.getByLabelText('Page Down')).toBeInTheDocument();
    expect(screen.getByLabelText('Home')).toBeInTheDocument();
    expect(screen.getByLabelText('End')).toBeInTheDocument();
    expect(screen.getByLabelText('Quit pager')).toBeInTheDocument();
    // Base keys still present.
    expect(screen.getByLabelText('Up')).toBeInTheDocument();
  });

  it('POSTs the pager quit key to the special-keys API', async () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" showPagerKeys />);
    fireEvent.click(screen.getByLabelText('Quit pager'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({ cliToolId: 'codex', keys: ['q'] });
  });

  it('includes instanceId in the body for a non-primary instance (Issue #869)', async () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="codex" instanceId="codex-2" showPagerKeys />);
    fireEvent.click(screen.getByLabelText('Page Up'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ cliToolId: 'codex', keys: ['PageUp'], instanceId: 'codex-2' });
  });
});
