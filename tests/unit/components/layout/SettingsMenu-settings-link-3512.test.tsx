/**
 * @vitest-environment jsdom
 */

/**
 * "Settings…" in the shared SettingsMenu is a link to /more again (Issue #3512
 * review, the old Header entry's #2709 behaviour):
 *
 *   - a plain left click (or Enter) opens the settings modal on the PC and
 *     goes to /more on the phone, without the browser navigating;
 *   - a ⌘ / Ctrl / Shift / middle click is the browser's (new tab / window):
 *     not prevented, and no modal.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/sessions',
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobile.value,
  MOBILE_BREAKPOINT: 768,
}));

const settingsDialogMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/contexts/SettingsDialogContext', () => ({
  useSettingsDialog: () => ({ isOpen: false, open: settingsDialogMock.open, close: settingsDialogMock.close }),
}));

import { SettingsMenu, SettingsMenuTrigger } from '@/components/layout/SettingsMenu';

function renderMenu() {
  render(
    <SettingsMenu testIdPrefix="probe">
      <SettingsMenuTrigger asChild>
        <button type="button" data-testid="probe-trigger">open</button>
      </SettingsMenuTrigger>
    </SettingsMenu>,
  );
  fireEvent.keyDown(screen.getByTestId('probe-trigger'), { key: 'Enter' });
  return screen.getByRole('menuitem', { name: 'Settings' });
}

/** Dispatch a click and report whether the browser default was prevented. */
function click(target: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/** Let Radix's close (setTimeout 0) and the microtask that opens the modal run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  vi.clearAllMocks();
  mobile.value = false;
});

describe('SettingsMenu "Settings…" link (Issue #3512)', () => {
  it('is an <a href="/more"> menu item', () => {
    const item = renderMenu();
    expect(item.tagName).toBe('A');
    expect(item).toHaveAttribute('href', '/more');
    expect(item).toHaveAttribute('data-testid', 'probe-settings');
  });

  it.each([
    ['⌘', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Shift', { shiftKey: true }],
    ['middle', { button: 1 }],
  ] as const)('leaves a %s click to the browser and opens no modal', async (_label, init) => {
    const item = renderMenu();
    expect(click(item, init)).toBe(false);
    await settle();
    expect(settingsDialogMock.open).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('opens the modal on a plain click, without the browser navigating (negative control)', async () => {
    const item = renderMenu();
    expect(click(item)).toBe(true);
    await waitFor(() => expect(settingsDialogMock.open).toHaveBeenCalledTimes(1));
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('opens the modal from the keyboard (Enter) as before', async () => {
    const item = renderMenu();
    fireEvent.keyDown(item, { key: 'Enter' });
    await waitFor(() => expect(settingsDialogMock.open).toHaveBeenCalledTimes(1));
  });

  it('goes to /more through the router on the phone, without a browser navigation', async () => {
    mobile.value = true;
    const item = renderMenu();
    expect(click(item)).toBe(true);
    expect(routerMock.push).toHaveBeenCalledWith('/more');
    await settle();
    expect(settingsDialogMock.open).not.toHaveBeenCalled();
  });

  it('does not let a modified click leak into the next plain one', async () => {
    let item = renderMenu();
    click(item, { metaKey: true });
    await settle();
    fireEvent.keyDown(screen.getByTestId('probe-trigger'), { key: 'Enter' });
    item = screen.getByRole('menuitem', { name: 'Settings' });
    expect(click(item)).toBe(true);
    await waitFor(() => expect(settingsDialogMock.open).toHaveBeenCalledTimes(1));
  });
});
