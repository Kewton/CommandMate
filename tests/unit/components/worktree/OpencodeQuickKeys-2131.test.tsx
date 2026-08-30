/**
 * Tests for the desktop disclosure of OpencodeQuickKeys (Issue #2131).
 *
 * #2106 folded the strip on the phone and left PC always-open, on the written
 * assumption that "a split pane has the width". #2131 measured PC and found the
 * opposite: 578px of strip across eleven wrapped rows left `TerminalDisplay`
 * 64px in a 3-split pane. The pixels themselves are settled in a browser
 * (`tests/e2e/desktop-opencode-quick-keys-2131.spec.ts`) because jsdom has no
 * layout; what is settled HERE is everything a layout-free renderer can still
 * prove, in order of what would hurt most if it regressed:
 *
 *   1. PC gets a toggle at all, and it starts OPEN — the opposite of the phone.
 *   2. The two screens read SEPARATE localStorage keys, so folding the strip on
 *      one never folds it on the other.
 *   3. The notation suffix is hidden by a container query rather than deleted,
 *      so the accessible name still carries `ctrl+x a` at every width.
 *   4. Nothing about the phone's rendering moved.
 *
 * Real dictionary rather than the echo mock, for the same reason #2106 used one:
 * the toggle's accessible name is real wording and the echo mock would keep it
 * green for a key that does not exist.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  OpencodeQuickKeys,
  OPENCODE_QUICK_KEYS_NOTATION_MIN_CONTAINER_PX,
} from '@/components/worktree/OpencodeQuickKeys';
import {
  OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY,
  OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY,
} from '@/hooks/useOpencodeQuickKeysDisclosure';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) })
  );
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

/** The desktop caller's exact prop set (TerminalSplitPaneContent). */
const DESKTOP = { collapsible: true, layout: 'desktop' } as const;
/** The mobile caller's exact prop set (MobileTerminalTab). */
const MOBILE = { collapsible: true, layout: 'mobile', compact: true } as const;

describe('OpencodeQuickKeys on PC: it folds, and it starts open (Issue #2131)', () => {
  it('renders a toggle — PC is no longer the always-open branch', () => {
    renderStrip(DESKTOP);
    expect(screen.getByTestId('opencode-quick-keys-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-quick-keys-disclosure')).toBeInTheDocument();
  });

  it('starts OPEN with all seventeen keys showing', () => {
    renderStrip(DESKTOP);

    expect(screen.getByTestId('opencode-quick-keys-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^opencode-quick-key-/)).toHaveLength(17);
  });

  it('folds every key away on one click — the pixels the terminal gets back', () => {
    renderStrip(DESKTOP);
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));

    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^opencode-quick-key-/)).toHaveLength(0);
    // The toggle row survives, so the chords stay one click away (#2046).
    expect(screen.getByTestId('opencode-quick-keys-toggle')).toBeInTheDocument();
  });

  it('reopens on remount after being reopened — the state is a preference', () => {
    const first = renderStrip(DESKTOP);
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY)).toBe(
      'false'
    );
    first.unmount();

    // A fresh mount is what a reload looks like to this component.
    const second = renderStrip(DESKTOP);
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));
    second.unmount();

    renderStrip(DESKTOP);
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
  });

  it('still renders nothing at all for a non-opencode tool', () => {
    for (const cliToolId of ['claude', 'codex', 'copilot'] as const) {
      const { container, unmount } = renderStrip({ ...DESKTOP, cliToolId });
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('keeps the session gate on the chords it reveals', () => {
    renderStrip({ ...DESKTOP, hasAgentSession: false });
    expect(screen.getByTestId('opencode-quick-key-undo')).toBeDisabled();
    expect(screen.getByTestId('opencode-quick-key-agents')).toBeEnabled();
  });
});

describe('OpencodeQuickKeys: the phone and PC never share a preference (Issue #2131)', () => {
  it('writes PC\'s fold to the desktop key only', () => {
    renderStrip(DESKTOP);
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));

    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY)).toBe(
      'false'
    );
    expect(window.localStorage.getItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY)).toBeNull();
  });

  it('leaves PC open when the phone\'s stored preference says closed', () => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY, 'false');
    renderStrip(DESKTOP);
    expect(screen.getByTestId('opencode-quick-keys')).toBeInTheDocument();
  });

  it('leaves the phone closed when PC\'s stored preference says open', () => {
    window.localStorage.setItem(OPENCODE_QUICK_KEYS_DESKTOP_OPEN_STORAGE_KEY, 'true');
    renderStrip(MOBILE);
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
    expect(screen.getByTestId('opencode-quick-keys-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('keeps the phone CLOSED by default — #2131\'s acceptance condition', () => {
    renderStrip(MOBILE);
    expect(screen.queryByTestId('opencode-quick-keys')).not.toBeInTheDocument();
  });
});

describe('OpencodeQuickKeys: the notation suffix answers to the pane width (Issue #2131)', () => {
  it('makes the strip its own query container', () => {
    renderStrip(DESKTOP);
    expect(screen.getByTestId('opencode-quick-keys').className).toContain('@container');
  });

  it('hides the suffix below the declared container width and shows it above', () => {
    renderStrip(DESKTOP);
    const suffix = screen.getByTestId('opencode-quick-key-agents').querySelector('span');

    expect(suffix).not.toBeNull();
    expect(suffix).toHaveTextContent('ctrl+x a');
    // jsdom has no layout, so the CLASS is the assertion: `hidden` is the narrow
    // state and the container query is the only thing that undoes it. The
    // literal must agree with the exported constant — Tailwind 4 scans source
    // text, so an interpolated width would emit no CSS at all and the suffix
    // would be invisible at every width.
    expect(suffix!.className).toContain('hidden');
    expect(suffix!.className).toContain(
      `@min-[${OPENCODE_QUICK_KEYS_NOTATION_MIN_CONTAINER_PX}px]:inline`
    );
  });

  it('keeps the notation in the accessible name and the tooltip at every width', () => {
    renderStrip(DESKTOP);
    const button = screen.getByTestId('opencode-quick-key-agents');

    expect(button).toHaveAttribute('aria-label', expect.stringContaining('ctrl+x a'));
    expect(button.getAttribute('title')).toContain('ctrl+x a');
  });

  it('still deletes the suffix outright on the phone (compact), not merely hides it', () => {
    renderStrip(MOBILE);
    fireEvent.click(screen.getByTestId('opencode-quick-keys-toggle'));

    const button = screen.getByTestId('opencode-quick-key-agents');
    expect(button.querySelector('span')).toBeNull();
    expect(button).toHaveTextContent('Agents');
    expect(button).not.toHaveTextContent('ctrl+x a');
  });
});
