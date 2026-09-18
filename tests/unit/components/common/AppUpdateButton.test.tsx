/**
 * Unit tests for AppUpdateButton (Issue #2654).
 *
 * The button is the PC entry point to the update: it says which version it
 * would move you to, opens the provider's confirmation dialog, and — once the
 * update has settled in a way the user has to read — reopens the banner in a
 * modal. The wording is asserted through the real dictionaries, because the
 * label and both accessible names are the whole point of the control.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

const mockUseAppUpdate = vi.fn();
vi.mock('@/contexts/AppUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AppUpdateContext')>()),
  useAppUpdate: () => mockUseAppUpdate(),
}));

import { AppUpdateButton, RELEASES_LATEST_URL } from '@/components/common/AppUpdateButton';
import { makeAppUpdateValue, makeUpdateInfo } from '@tests/helpers/app-update-context';

beforeEach(() => {
  vi.clearAllMocks();
  locale.current = 'en';
  mockIsMobile.mockReturnValue(false);
  mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());
});

afterEach(() => {
  cleanup();
});

describe('AppUpdateButton visibility', () => {
  it('renders nothing while there is no update', () => {
    render(<AppUpdateButton />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });

  it('renders nothing on mobile: the phone keeps the update in the Info tab', () => {
    mockIsMobile.mockReturnValue(true);
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue({ updateInfo: makeUpdateInfo() }));

    render(<AppUpdateButton />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });

  it('renders nothing without a version to name', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo({ latestVersion: null }) })
    );

    render(<AppUpdateButton />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });
});

describe('AppUpdateButton idle', () => {
  it.each(['global', 'npx'] as const)(
    'is a button that opens the confirmation for a %s install',
    (installType) => {
      const value = makeAppUpdateValue({ updateInfo: makeUpdateInfo({ installType }) });
      mockUseAppUpdate.mockReturnValue(value);

      render(<AppUpdateButton />);
      const button = screen.getByTestId('app-update-button');
      expect(button.tagName).toBe('BUTTON');

      fireEvent.click(button);
      expect(value.openConfirm).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['en', 'Update v0.39.0', 'Update CommandMate to v0.39.0'],
    ['ja', 'Update v0.39.0', 'CommandMate を v0.39.0 にアップデート'],
  ])('names the version in %s', (loc, label, ariaLabel) => {
    locale.current = loc;
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue({ updateInfo: makeUpdateInfo() }));

    render(<AppUpdateButton />);
    const button = screen.getByTestId('app-update-button');
    expect(button.textContent).toContain(label);
    expect(button.getAttribute('aria-label')).toBe(ariaLabel);
  });

  it('is a release link for an install that cannot update itself', () => {
    const value = makeAppUpdateValue({
      updateInfo: makeUpdateInfo({ installType: 'local', updateCommand: null }),
    });
    mockUseAppUpdate.mockReturnValue(value);

    render(<AppUpdateButton />);
    const link = screen.getByTestId('app-update-button');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/Kewton/CommandMate/releases/tag/v0.39.0'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('Open the v0.39.0 release page');

    fireEvent.click(link);
    expect(value.openConfirm).not.toHaveBeenCalled();
  });

  it('falls back to the latest-release page when the check returned no URL', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({
        updateInfo: makeUpdateInfo({ installType: 'unknown', releaseUrl: null }),
      })
    );

    render(<AppUpdateButton />);
    expect(screen.getByTestId('app-update-button').getAttribute('href')).toBe(
      RELEASES_LATEST_URL
    );
  });
});

describe('AppUpdateButton while the update runs', () => {
  it.each(['starting', 'updating'] as const)('is disabled and spinning in %s', (state) => {
    const value = makeAppUpdateValue({ updateInfo: makeUpdateInfo(), state });
    mockUseAppUpdate.mockReturnValue(value);

    render(<AppUpdateButton />);
    const button = screen.getByTestId('app-update-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Updating');
    expect(button.querySelector('.animate-spin')).not.toBeNull();

    fireEvent.click(button);
    expect(value.openConfirm).not.toHaveBeenCalled();
  });

  it('says "更新中…" in ja', () => {
    locale.current = 'ja';
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo(), state: 'updating' })
    );

    render(<AppUpdateButton />);
    expect(screen.getByTestId('app-update-button').textContent).toContain('更新中…');
  });
});

describe('AppUpdateButton after the update settled', () => {
  it('opens the banner in a modal on timeout, with the manual command', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo(), state: 'timeout' })
    );

    render(<AppUpdateButton />);
    fireEvent.click(screen.getByTestId('app-update-button'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(screen.getByTestId('update-timeout')).toBeDefined();
    expect(screen.getByText('commandmate update')).toBeDefined();
    expect(dialog.textContent).toContain('Update status');
  });

  /**
   * After a no-restart update the recheck can legitimately report no update at
   * all (the new version is installed), so the button must not vanish with the
   * message the user still has to read.
   */
  it('still offers the no-restart message once the recheck reports no update', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({
        updateInfo: makeUpdateInfo({ hasUpdate: false }),
        state: 'no-restart',
      })
    );

    render(<AppUpdateButton />);
    fireEvent.click(screen.getByTestId('app-update-button'));

    expect(screen.getByTestId('update-no-restart')).toBeDefined();
  });

  it('shows the start failure that the user has to act on', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({
        updateInfo: makeUpdateInfo(),
        state: 'error',
        errorKey: 'update.errorInProgress',
      })
    );

    render(<AppUpdateButton />);
    fireEvent.click(screen.getByTestId('app-update-button'));

    expect(screen.getByTestId('update-error')).toBeDefined();
    expect(screen.getByText('An update is already running.')).toBeDefined();
  });
});

describe('AppUpdateButton width contract (Issue #2481)', () => {
  it.each([
    ['button', 'global'],
    ['link', 'local'],
  ] as const)('never shrinks or wraps as a %s', (_form, installType) => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo({ installType }) })
    );

    render(<AppUpdateButton />);
    const className = screen.getByTestId('app-update-button').className;
    expect(className).toContain('flex-shrink-0');
    expect(className).toContain('whitespace-nowrap');
  });
});
