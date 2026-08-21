/**
 * Tests for UnsentComposerBar (Issue #1879).
 *
 * Three properties this file is here to hold:
 *
 *  1. **[Run] uses the EXISTING special-keys endpoint with `['Enter']`.** The
 *     Issue is explicit that no new key API may be introduced; `NAVIGATION_KEY_VALUES`
 *     has carried `'Enter'` since #473, so the assertion is on the URL and body.
 *  2. **The bar's gate is the composer's contents.** It takes no detection flag
 *     as a prop, so "does not depend on detection state" is a fact about its
 *     interface, not a behaviour that could drift — asserted below by rendering
 *     it with nothing but text.
 *  3. **No Enter affordance when the box is empty.** Blank / whitespace-only
 *     text renders nothing at all, which is what preserves the #1017/#1494 guard
 *     property ("Enter can never reach an empty composer through this surface").
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  UnsentComposerBar,
  COMPOSER_PREVIEW_MAX_CHARS,
  hasUnsentComposerText,
} from '@/components/worktree/UnsentComposerBar';

describe('UnsentComposerBar (Issue #1879)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the unsent text with Run and Clear actions', () => {
    render(
      <UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText="/work-plan" />,
    );

    expect(screen.getByTestId('unsent-composer-bar')).toBeInTheDocument();
    expect(screen.getByTestId('unsent-composer-text')).toHaveTextContent('/work-plan');
    expect(screen.getByRole('button', { name: 'worktree.unsentComposer.run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'worktree.unsentComposer.clear' })).toBeInTheDocument();
  });

  it.each(['', '   ', '\n\n'])('renders nothing (no Enter affordance) for %j', (text) => {
    const { container } = render(
      <UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText={text} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('unsent-composer-bar')).not.toBeInTheDocument();
  });

  it('sends Enter through the existing special-keys API — no new endpoint', async () => {
    render(
      <UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText="/work-plan" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.run' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ cliToolId: 'claude', keys: ['Enter'] });
  });

  it('targets a non-primary instance when one is given', async () => {
    render(
      <UnsentComposerBar
        worktreeId="w-1"
        cliToolId="claude"
        instanceId="claude-2"
        composerText="/work-plan"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.run' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      cliToolId: 'claude',
      keys: ['Enter'],
      instanceId: 'claude-2',
    });
  });

  it('clears the composer through the clear-composer endpoint', async () => {
    render(
      <UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText="/work-plan" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.clear' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/w-1/clear-composer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ cliToolId: 'claude' });
  });

  it('refreshes the terminal after each action', async () => {
    vi.useFakeTimers();
    try {
      const onActionSent = vi.fn();
      render(
        <UnsentComposerBar
          worktreeId="w-1"
          cliToolId="claude"
          composerText="/work-plan"
          onActionSent={onActionSent}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'worktree.unsentComposer.run' }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(500);

      expect(onActionSent).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates a very long composer for display but keeps the bar usable', () => {
    const long = 'y'.repeat(COMPOSER_PREVIEW_MAX_CHARS + 200);
    render(<UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText={long} />);

    const shown = screen.getByTestId('unsent-composer-text').textContent ?? '';
    expect(shown.length).toBeLessThanOrEqual(COMPOSER_PREVIEW_MAX_CHARS + 1);
    expect(shown.endsWith('…')).toBe(true);
    expect(screen.getByRole('button', { name: 'worktree.unsentComposer.run' })).toBeInTheDocument();
  });

  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['   ', false],
    ['/work-plan', true],
  ])('hasUnsentComposerText(%j) === %s', (input, expected) => {
    // Both surfaces gate on this one predicate, so the gate cannot pick up a
    // detection flag on one of them and not the other. It tolerates a missing
    // value because the bar is decoration: a terminal pane must not fail to
    // render because the composer read was absent.
    expect(hasUnsentComposerText(input as string | null | undefined)).toBe(expected);
  });

  it('describes the text neutrally — never as a recommendation', () => {
    // Issue #1879 design constraint 1: the frame cannot tell whether the agent
    // pre-filled the box or a human typed half a sentence and walked away.
    render(<UnsentComposerBar worktreeId="w-1" cliToolId="claude" composerText="/work-plan" />);
    expect(screen.getByText('worktree.unsentComposer.label')).toBeInTheDocument();
  });
});
