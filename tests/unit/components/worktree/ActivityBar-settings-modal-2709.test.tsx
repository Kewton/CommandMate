/**
 * ActivityBar settings menu → settings modal (Issue #2709)
 *
 * The point of this file is where focus ends up, so neither
 * `useSettingsDialog` nor `Modal` is mocked: the real provider drives a real
 * `Modal` (and therefore a real `useFocusTrap`) mounted next to the bar. A
 * test that only spies on `open()` would pass just as happily with the
 * `onCloseAutoFocus` + `preventDefault()` variant, which opens the modal with
 * `<body>` recorded as the opener and never gives the gear its focus back.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ActivityBar } from '@/components/worktree/ActivityBar';
import { Modal } from '@/components/ui/Modal';
import { SettingsDialogProvider, useSettingsDialog } from '@/contexts/SettingsDialogContext';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

// The menu item is matched by its rendered English label, so resolve wording
// through the real dictionary rather than the key-echoing global mock.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const sidebarMock = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

/** Stands in for SettingsDialog: same context, same Modal, trivial contents. */
function ProbeModal() {
  const { isOpen, close } = useSettingsDialog();
  return (
    <Modal isOpen={isOpen} onClose={close} title="Settings">
      <button type="button" data-testid="probe-inside">
        inside
      </button>
    </Modal>
  );
}

function Fixture() {
  return (
    <SettingsDialogProvider>
      <ActivityBar active={null} onToggle={vi.fn()} />
      <ProbeModal />
    </SettingsDialogProvider>
  );
}

function openMenu(): HTMLElement {
  const gear = screen.getByTestId('activity-bar-settings');
  fireEvent.keyDown(gear, { key: 'Enter' });
  return gear;
}

describe('ActivityBar settings menu opens the settings modal (Issue #2709)', () => {
  beforeAll(() => {
    installRadixJsdomPolyfills();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the modal without navigating, and focus lands on the modal panel', async () => {
    render(<Fixture />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

    await waitFor(() => expect(screen.getByTestId('modal-panel')).toBeInTheDocument());
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('modal-panel'));
  });

  it('returns focus to the gear when the modal is closed', async () => {
    render(<Fixture />);
    const gear = openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await waitFor(() => expect(screen.getByTestId('modal-panel')).toBeInTheDocument());

    fireEvent.keyDown(document, { key: 'Escape' });

    // The gear, not <body>: the trap recorded it as the opener because Radix
    // had already restored focus there when the modal mounted.
    await waitFor(() => expect(document.activeElement).toBe(gear));
    await waitFor(() => expect(screen.queryByTestId('modal-panel')).toBeNull());
  });

  it('leaves the modal closed when the menu itself is dismissed', async () => {
    render(<Fixture />);
    const gear = openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(gear));
    expect(screen.queryByTestId('modal-panel')).toBeNull();
  });

  it('still navigates for Skills and opens no modal', async () => {
    render(<Fixture />);
    const gear = openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Skills' }));
    expect(routerMock.push).toHaveBeenCalledWith('/skills');

    await waitFor(() => expect(document.activeElement).toBe(gear));
    expect(screen.queryByTestId('modal-panel')).toBeNull();
  });
});
