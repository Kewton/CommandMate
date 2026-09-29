/**
 * OpencodeQuickKeys for OpenCode V2 (Issue #2966).
 *
 * The v2 table is chosen by tool id and carries the keys measured on
 * `opencode2` 2.0.18: `shift+tab` is the agent switch (v1's `Tab` is not one
 * there), `ctrl+x t` is not themes, and there is no session-scoped group. v1's
 * strip is pinned by its own suites (#2046 / #2106 / #2131 / #2174), unchanged.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  OpencodeQuickKeys,
  opencodeQuickKeyBindings,
} from '@/components/worktree/OpencodeQuickKeys';

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

function sentBody(callIndex = 0): { keys: string[]; cliToolId: string } {
  const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

function renderStrip(props: Partial<React.ComponentProps<typeof OpencodeQuickKeys>> = {}) {
  return render(
    <OpencodeQuickKeys worktreeId="w-1" cliToolId="opencode-v2" hasAgentSession={false} {...props} />,
  );
}

/** The measured 2.0.18 table, in render order. */
const V2_EXPECTED: ReadonlyArray<[id: string, keys: string[], notation: string]> = [
  ['agentNext', ['BTab'], 'shift+tab'],
  ['commands', ['C-p'], 'ctrl+p'],
  ['variant', ['C-t'], 'ctrl+t'],
  ['agents', ['C-x', 'a'], 'ctrl+x a'],
  ['sessions', ['C-x', 'l'], 'ctrl+x l'],
  ['newSession', ['C-x', 'n'], 'ctrl+x n'],
  ['models', ['C-x', 'm'], 'ctrl+x m'],
  ['pageUp', ['PageUp'], 'pgup'],
  ['pageDown', ['PageDown'], 'pgdn'],
  ['first', ['Home'], 'home'],
  ['last', ['End'], 'end'],
];

describe('[#2966] OpencodeQuickKeys renders a strip for opencode-v2', () => {
  it('renders the labelled toolbar', () => {
    renderStrip();
    expect(screen.getByRole('toolbar', { name: 'opencode quick keys' })).toBeInTheDocument();
  });

  it('renders exactly the measured buttons, in order', () => {
    renderStrip();
    const ids = screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-testid')?.replace('opencode-quick-key-', ''));
    expect(ids).toEqual(V2_EXPECTED.map(([id]) => id));
  });

  it.each(['agentPrev', 'themes', 'timeline', 'undo', 'redo', 'compact'])(
    'does not offer %s',
    (id) => {
      renderStrip({ hasAgentSession: true });
      expect(screen.queryByTestId(`opencode-quick-key-${id}`)).toBeNull();
    },
  );

  it('enables every button with no agent session (none of them is session-scoped)', () => {
    renderStrip({ hasAgentSession: false });
    for (const button of screen.getAllByRole('button')) {
      expect(button.hasAttribute('disabled')).toBe(false);
    }
  });
});

describe('[#2966] each v2 button sends the measured keys as one request', () => {
  it.each(V2_EXPECTED)('%s sends %j and names %s', async (id, keys, notation) => {
    renderStrip();
    const button = screen.getByTestId(`opencode-quick-key-${id}`);
    expect(button.getAttribute('aria-label')).toContain(`(${notation})`);
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('/api/worktrees/w-1/special-keys');
    expect(sentBody()).toMatchObject({ cliToolId: 'opencode-v2', keys });
  });

  it('switches agents with shift+tab, never with tab', async () => {
    renderStrip();
    fireEvent.click(screen.getByTestId('opencode-quick-key-agentNext'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody().keys).toEqual(['BTab']);
    expect(opencodeQuickKeyBindings('opencode-v2').flatMap(({ keys }) => keys)).not.toContain('Tab');
  });
});

describe('[#2966] the disclosure counts the v2 table, not v1’s', () => {
  it('says 11 on the v2 toggle and 17 on the v1 toggle', () => {
    const { unmount } = renderStrip({ collapsible: true, layout: 'desktop' });
    expect(screen.getByTestId('opencode-quick-keys-toggle').textContent).toContain('11');
    unmount();
    renderStrip({ cliToolId: 'opencode', collapsible: true, layout: 'desktop' });
    expect(screen.getByTestId('opencode-quick-keys-toggle').textContent).toContain('17');
  });
});

describe('[#2966] opencodeQuickKeyBindings', () => {
  it('returns the v2 table for opencode-v2 and nothing for a tool without one', () => {
    expect(opencodeQuickKeyBindings('opencode-v2').map(({ id, keys }) => [id, keys])).toEqual(
      V2_EXPECTED.map(([id, keys]) => [id, keys]),
    );
    expect(opencodeQuickKeyBindings('claude')).toEqual([]);
  });

  it('leaves v1’s table as it was: Tab / BTab agents and all seventeen keys', () => {
    const v1 = opencodeQuickKeyBindings('opencode');
    expect(v1).toHaveLength(17);
    expect(v1.find(({ id }) => id === 'agentNext')?.keys).toEqual(['Tab']);
    expect(v1.find(({ id }) => id === 'agentPrev')?.keys).toEqual(['BTab']);
  });
});
