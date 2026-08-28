/**
 * Tests for OpencodeQuickKeys (Issue #2046) and for the acceptance condition
 * that the shared navigation surfaces did NOT change.
 *
 * Two halves, and the second is the more important one:
 *
 * 1. The new strip renders opencode's chords, sends them as one request with the
 *    leader as a separate array entry, and omits / disables exactly what §22 of
 *    `docs/design/opencode-server-live-verification.md` says it must.
 * 2. `NavigationButtons` and `TerminalEscapeHatch` render byte-identically for
 *    claude and codex, and send the same keys they sent before. Those two
 *    components are shared by every tool, so the way this Issue could break the
 *    other six is by touching them — the snapshots below are what makes that
 *    impossible to do quietly.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { OPENCODE_LEADER_KEY } from '@/types/terminal-keys';

// Real dictionary: this file asserts rendered wording, and the global echo mock
// would keep those assertions green for a key that does not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The `keys` array of the nth special-keys POST. */
function sentKeys(callIndex = 0): string[] {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(String(init.body)).keys;
}

function renderStrip(props: Partial<React.ComponentProps<typeof OpencodeQuickKeys>> = {}) {
  return render(
    <OpencodeQuickKeys
      worktreeId="w-1"
      cliToolId="opencode"
      hasAgentSession
      {...props}
    />
  );
}

describe('OpencodeQuickKeys renders only for opencode (Issue #2046)', () => {
  it.each(['claude', 'codex', 'gemini', 'copilot', 'vibe-local', 'antigravity'] as const)(
    'renders nothing at all for %s',
    (cliToolId) => {
      const { container } = renderStrip({ cliToolId });
      expect(container).toBeEmptyDOMElement();
    }
  );

  it('renders a labelled toolbar for opencode', () => {
    renderStrip();
    expect(screen.getByRole('toolbar', { name: 'opencode quick keys' })).toBeInTheDocument();
  });
});

describe('OpencodeQuickKeys sends the measured key sequences (Issue #2046)', () => {
  it('sends `Tab` for the next agent — the acceptance criterion’s key', async () => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Next agent (tab)' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/worktrees/w-1/special-keys');
    expect(sentKeys()).toEqual(['Tab']);
  });

  it.each([
    ['Previous agent (shift+tab)', ['BTab']],
    ['Commands (ctrl+p)', ['C-p']],
    ['Variant (ctrl+t)', ['C-t']],
    ['Page up (pgup)', ['PageUp']],
    ['Latest message (end)', ['End']],
  ])('sends %s as %j', async (label, expected) => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentKeys()).toEqual(expected);
  });

  it.each([
    ['Agents (ctrl+x a)', 'a'],
    ['Sessions (ctrl+x l)', 'l'],
    ['New session (ctrl+x n)', 'n'],
    ['Models (ctrl+x m)', 'm'],
    ['Themes (ctrl+x t)', 't'],
    ['Timeline (ctrl+x g)', 'g'],
    ['Undo (ctrl+x u)', 'u'],
    ['Redo (ctrl+x r)', 'r'],
    ['Compact (ctrl+x c)', 'c'],
  ])('sends %s as a two-step chord ending in %s', async (label, letter) => {
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Two entries in ONE request. `sendSpecialKeys()` inserts the delay; joining
    // them here would send the literal string "C-x a" to tmux instead.
    expect(sentKeys()).toEqual([OPENCODE_LEADER_KEY, letter]);
  });

  it('passes a non-primary instanceId through, and omits it for the primary', async () => {
    const { unmount } = renderStrip({ instanceId: 'opencode-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Commands (ctrl+p)' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      cliToolId: 'opencode',
      keys: ['C-p'],
      instanceId: 'opencode-2',
    });
    unmount();

    renderStrip({ instanceId: 'opencode' });
    fireEvent.click(screen.getByRole('button', { name: 'Commands (ctrl+p)' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      cliToolId: 'opencode',
      keys: ['C-p'],
    });
  });
});

describe('OpencodeQuickKeys omits and gates what #2046 measured (Issue #2046)', () => {
  it('offers no sidebar button at any width or session state', () => {
    renderStrip();
    expect(screen.queryByRole('button', { name: /sidebar/i })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')).not.toContain('ctrl+x b');
    }
  });

  it('offers no F2 / model-cycle button', () => {
    renderStrip();
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')?.toLowerCase()).not.toContain('f2');
    }
  });

  it('disables the session-scoped chords until the pane reports a session', () => {
    renderStrip({ hasAgentSession: false });

    for (const label of [
      'Timeline (ctrl+x g)',
      'Undo (ctrl+x u)',
      'Redo (ctrl+x r)',
      'Compact (ctrl+x c)',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    // The always-available ones are not collateral damage.
    for (const label of ['Agents (ctrl+x a)', 'Sessions (ctrl+x l)', 'Commands (ctrl+p)', 'Next agent (tab)']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('does not send a session-scoped chord while it is disabled', async () => {
    renderStrip({ hasAgentSession: false });
    fireEvent.click(screen.getByRole('button', { name: 'Undo (ctrl+x u)' }));

    // A stray `u` in the composer is exactly what the gate exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains the gate in the disabled button’s tooltip', () => {
    renderStrip({ hasAgentSession: false });
    expect(screen.getByRole('button', { name: 'Undo (ctrl+x u)' })).toHaveAttribute(
      'title',
      "Available after this pane's first turn (ctrl+x u)"
    );
  });

  it('drops the key-notation suffix in compact mode but keeps the accessible name', () => {
    const { unmount } = renderStrip();
    expect(screen.getByRole('button', { name: 'Commands (ctrl+p)' }).textContent).toBe('Commandsctrl+p');
    unmount();

    renderStrip({ compact: true });
    const compact = screen.getByRole('button', { name: 'Commands (ctrl+p)' });
    expect(compact.textContent).toBe('Commands');
    // Touch target survives the compaction (44px minimum, Issue #473's rule).
    expect(compact.className).toContain('min-h-[44px]');
  });
});

describe('Issue #2046 acceptance: the shared navigation surfaces did not change', () => {
  it.each(['claude', 'codex'] as const)(
    'NavigationButtons renders identically for %s',
    (cliToolId) => {
      const { container } = render(<NavigationButtons worktreeId="w-1" cliToolId={cliToolId} />);
      expect(container.firstChild).toMatchSnapshot();
    }
  );

  it.each(['claude', 'codex'] as const)(
    'NavigationButtons with the pager keys renders identically for %s',
    (cliToolId) => {
      const { container } = render(
        <NavigationButtons worktreeId="w-1" cliToolId={cliToolId} showPagerKeys />
      );
      expect(container.firstChild).toMatchSnapshot();
    }
  );

  it.each(['claude', 'codex'] as const)(
    'TerminalEscapeHatch renders identically for %s',
    (cliToolId) => {
      const { container } = render(<TerminalEscapeHatch worktreeId="w-1" cliToolId={cliToolId} />);
      expect(container.firstChild).toMatchSnapshot();
    }
  );

  it('still sends the same single key from NavigationButtons', async () => {
    render(<NavigationButtons worktreeId="w-1" cliToolId="claude" />);
    fireEvent.click(screen.getByLabelText('Up'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      cliToolId: 'claude',
      keys: ['Up'],
    });
  });

  it('still sends the same single key from TerminalEscapeHatch', async () => {
    render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="codex" />);
    fireEvent.click(screen.getByLabelText('Send q (quit)'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      cliToolId: 'codex',
      keys: ['q'],
    });
  });

  it('does not surface an opencode chord on either shared surface', () => {
    const nav = render(<NavigationButtons worktreeId="w-1" cliToolId="opencode" showPagerKeys />);
    const hatch = render(<TerminalEscapeHatch worktreeId="w-1" cliToolId="opencode" />);

    for (const { container } of [nav, hatch]) {
      for (const button of Array.from(container.querySelectorAll('button'))) {
        expect(button.getAttribute('aria-label')).not.toMatch(/ctrl\+/);
      }
    }
  });
});
