/**
 * Tests for the collapsible mode of OpencodeQuickKeys (Issue #2106).
 *
 * #2046 put seventeen 44px targets under the phone's terminal. Measured in a
 * real browser (`tests/e2e/mobile-opencode-quick-keys-2106.spec.ts`) that strip
 * is 378px tall and left `TerminalDisplay` 40px at 390x730 and 0px at 360x640.
 * The fix is a disclosure that is CLOSED by default — so these assert, in order
 * of what would hurt most if it regressed:
 *
 *   1. `collapsible` starts closed, and the closed footprint is one 44px row.
 *   2. Opening it yields the same seventeen keys in the same order, sending the
 *      same requests — the strip is folded, not trimmed.
 *   3. WITHOUT `collapsible` nothing changes at all, including when a stored
 *      preference exists. That is the PC (`TerminalSplitPaneContent`) contract.
 *
 * Real dictionary rather than the echo mock: the toggle's accessible name is new
 * wording, and the echo mock would keep it green for a key that does not exist.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY } from '@/hooks/useOpencodeQuickKeysDisclosure';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderStrip(props: Partial<React.ComponentProps<typeof OpencodeQuickKeys>> = {}) {
  return render(
    <OpencodeQuickKeys worktreeId="w-1" cliToolId="opencode" hasAgentSession {...props} />
  );
}

/** Accessible names of every key button, in DOM order. */
function keyNamesInOrder(): string[] {
  return screen
    .getAllByTestId(/^opencode-quick-key-/)
    .map(button => button.getAttribute('aria-label') ?? '');
}

describe('OpencodeQuickKeys collapsible: closed by default (Issue #2106)', () => {
  it('renders only the toggle — the seventeen keys are not in the DOM', () => {
    renderStrip({ collapsible: true });

    expect(screen.getByTestId('opencode-quick-keys-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^opencode-quick-key-/)).toHaveLength(0);
  });

  it('gives the closed toggle a 44px tap target (Issue #1127 rule)', () => {
    renderStrip({ collapsible: true });
    const toggle = screen.getByTestId('opencode-quick-keys-toggle');

    expect(toggle.className).toContain('min-h-[44px]');
    expect(toggle.className).toContain('touch-manipulation');
  });

  it('says how many keys are folded away, derived from the groups', () => {
    renderStrip({ collapsible: true });
    expect(screen.getByTestId('opencode-quick-keys-toggle')).toHaveTextContent('17');
  });

  it('names itself for a screen reader in both states, from the real dictionary', () => {
    renderStrip({ collapsible: true });
    const toggle = screen.getByTestId('opencode-quick-keys-toggle');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-label', 'Show opencode quick keys');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-label', 'Hide opencode quick keys');
  });

  it('points aria-controls at the panel it actually reveals', () => {
    renderStrip({ collapsible: true });
    const toggle = screen.getByTestId('opencode-quick-keys-toggle');
    fireEvent.click(toggle);

    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(screen.getByTestId('opencode-quick-keys')).toHaveAttribute('id', String(panelId));
  });

  it('folds back closed on a second tap', () => {
    renderStrip({ collapsible: true });
    const toggle = screen.getByTestId('opencode-quick-keys-toggle');

    fireEvent.click(toggle);
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
  });

  it('renders nothing at all — not even a toggle — for another tool', () => {
    const { container } = renderStrip({ collapsible: true, cliToolId: 'claude' });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('OpencodeQuickKeys collapsible: opening changes nothing but visibility (Issue #2106)', () => {
  it('reveals the same seventeen keys in the same order as the PC strip', () => {
    const pc = renderStrip();
    const pcNames = keyNamesInOrder();
    pc.unmount();

    renderStrip({ collapsible: true, compact: true });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));

    expect(pcNames).toHaveLength(17);
    expect(keyNamesInOrder()).toEqual(pcNames);
  });

  it('still sends the two-step leader chord unchanged', async () => {
    renderStrip({ collapsible: true, compact: true });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    fireEvent.click(screen.getByTestId('opencode-quick-key-agents'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/worktrees/w-1/special-keys');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      cliToolId: 'opencode',
      keys: ['C-x', 'a'],
    });
  });

  it('keeps the session gate — a disabled chord stays disabled and silent', async () => {
    renderStrip({ collapsible: true, hasAgentSession: false });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));

    expect(screen.getByTestId('opencode-quick-key-undo')).toBeDisabled();
    fireEvent.click(screen.getByTestId('opencode-quick-key-undo'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still exposes the panel as a labelled toolbar once open', () => {
    renderStrip({ collapsible: true });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    expect(screen.getByRole('toolbar', { name: 'opencode quick keys' })).toBeInTheDocument();
  });
});

describe('OpencodeQuickKeys collapsible: the state survives a reload (Issue #2106)', () => {
  it('reopens on remount after being opened', () => {
    const first = renderStrip({ collapsible: true });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBe('true');
    first.unmount();

    renderStrip({ collapsible: true });
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-quick-keys-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('stays closed on remount after being closed again', () => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, 'true');
    const first = renderStrip({ collapsible: true });
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    first.unmount();

    renderStrip({ collapsible: true });
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
  });
});

describe('Issue #2106 acceptance: the PC strip is untouched', () => {
  it('renders no toggle and no disclosure wrapper without the flag', () => {
    renderStrip();

    expect(screen.queryByTestId('opencode-quick-keys-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('opencode-quick-keys-disclosure')).not.toBeInTheDocument();
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^opencode-quick-key-/)).toHaveLength(17);
  });

  it.each([
    ['open', 'true'],
    ['closed', 'false'],
  ])('ignores a stored %s preference — PC never folds', (_label, stored) => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, stored);
    renderStrip();

    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^opencode-quick-key-/)).toHaveLength(17);
    expect(screen.queryByTestId('opencode-quick-keys-toggle')).not.toBeInTheDocument();
  });

  it('keeps its own caption and background when it is not inside a disclosure', () => {
    renderStrip();
    const toolbar = screen.getByTestId('opencode-quick-keys');

    expect(toolbar).toHaveTextContent('opencode');
    expect(toolbar.className).toContain('bg-muted');
    expect(toolbar).not.toHaveAttribute('id');
  });
});
