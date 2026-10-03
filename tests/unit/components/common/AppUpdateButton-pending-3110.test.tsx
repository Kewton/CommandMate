/**
 * AppUpdateButton while the release is not on npm yet (Issue #3110).
 *
 * GitHub releases ahead of npm; until npm serves the version the button must
 * say so and must not start an update that would install nothing. Asserted
 * through the real dictionaries in both locales.
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

import { AppUpdateButton } from '@/components/common/AppUpdateButton';
import { makeAppUpdateValue, makeUpdateInfo } from '@tests/helpers/app-update-context';

const PENDING_INFO = makeUpdateInfo({
  hasUpdate: false,
  latestVersion: '0.44.0',
  updateCommand: null,
  pendingVersion: '0.44.0',
});

beforeEach(() => {
  vi.clearAllMocks();
  locale.current = 'en';
  mockIsMobile.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

describe('AppUpdateButton pending on npm (Issue #3110)', () => {
  it.each([
    ['en', 'v0.44.0 coming soon', /not on npm yet/],
    ['ja', 'v0.44.0 公開準備中', /npm への反映待ち/],
  ])('%s: renders a disabled "pending" button that cannot start the update', (lang, label, description) => {
    locale.current = lang;
    const value = makeAppUpdateValue({ updateInfo: PENDING_INFO });
    mockUseAppUpdate.mockReturnValue(value);

    render(<AppUpdateButton />);

    const button = screen.getByTestId('app-update-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-state')).toBe('pending');
    expect(button.textContent).toBe(label);
    expect(button.getAttribute('title')).toMatch(description);
    expect(button.getAttribute('aria-label')).toMatch(description);

    fireEvent.click(button);
    expect(value.openConfirm).not.toHaveBeenCalled();
  });

  it('renders the normal update button once npm serves the version', () => {
    mockUseAppUpdate.mockReturnValue(
      makeAppUpdateValue({ updateInfo: makeUpdateInfo({ latestVersion: '0.44.0' }) })
    );

    render(<AppUpdateButton />);

    const button = screen.getByTestId('app-update-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Update v0.44.0');
  });

  it('renders nothing on mobile (the phone keeps the update UI in the Info tab)', () => {
    mockIsMobile.mockReturnValue(true);
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue({ updateInfo: PENDING_INFO }));

    render(<AppUpdateButton />);
    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });
});
