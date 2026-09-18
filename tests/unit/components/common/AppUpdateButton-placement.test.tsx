/**
 * Where the update entry point lives (Issue #2654).
 *
 * The button is useless if it is not reachable, and #2481 fixed exactly that
 * failure for this corner of the header: the controls group never shrinks, so
 * anything inside it survives a narrow header. This file pins that the button
 * is *in* that group on the branch screen (and in the global nav elsewhere),
 * and where in the row it sits — ahead of the display-size selector and the
 * Info button, ahead of the theme toggle.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  // TransitionLink (#1122) reads the router at render time.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ setOpen: vi.fn() }),
}));

vi.mock('@/components/common/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

const mockUseAppUpdate = vi.fn();
vi.mock('@/contexts/AppUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AppUpdateContext')>()),
  useAppUpdate: () => mockUseAppUpdate(),
}));

import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';
import { Header } from '@/components/layout/Header';
import { makeAppUpdateValue, makeUpdateInfo } from '@tests/helpers/app-update-context';

const headerProps = {
  worktreeName: 'feature/2654-worktree',
  repositoryName: 'CommandMate',
  status: 'running' as const,
  onInfoClick: vi.fn(),
};

/** `a.compareDocumentPosition(b)` says b follows a in document order. */
function comesBefore(first: Element, second: Element): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAppUpdate.mockReturnValue(makeAppUpdateValue({ updateInfo: makeUpdateInfo() }));
});

afterEach(() => {
  cleanup();
});

describe('AppUpdateButton in DesktopHeader (Issue #2654)', () => {
  it('sits in the controls group, ahead of the display size and Info button', () => {
    render(<DesktopHeader {...headerProps} hasUpdate />);

    const controls = screen.getByTestId('desktop-header-controls');
    const button = screen.getByTestId('app-update-button');
    expect(controls.contains(button)).toBe(true);
    // #2481: the group never shrinks, so nothing inside it can be clipped.
    expect(controls.className).toMatch(/\bflex-shrink-0\b/);

    expect(comesBefore(button, screen.getByTestId('pc-display-size-select'))).toBe(true);
    expect(comesBefore(button, screen.getByTestId('desktop-info-button'))).toBe(true);
  });

  it('leaves the Info button dot alone: both say an update is available', () => {
    render(<DesktopHeader {...headerProps} hasUpdate />);

    expect(screen.getByTestId('info-update-indicator')).toBeDefined();
    expect(screen.getByTestId('app-update-button')).toBeDefined();
  });

  it('is absent with the default (no update) context value', () => {
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());

    render(<DesktopHeader {...headerProps} />);

    expect(screen.queryByTestId('app-update-button')).toBeNull();
    expect(screen.getByTestId('desktop-header-controls')).toBeDefined();
  });
});

describe('AppUpdateButton in the global Header (Issue #2654)', () => {
  it('sits in the nav, ahead of the theme toggle', () => {
    render(<Header />);

    const nav = screen.getByRole('navigation');
    const button = screen.getByTestId('app-update-button');
    expect(nav.contains(button)).toBe(true);
    expect(comesBefore(button, screen.getByTestId('theme-toggle'))).toBe(true);
  });

  it('is absent with the default (no update) context value', () => {
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());

    render(<Header />);

    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });
});
