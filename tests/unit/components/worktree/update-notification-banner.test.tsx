/**
 * Unit tests for UpdateNotificationBanner component
 * Issue #257: Version update notification feature
 * Issue #1198: one-click self-update state machine
 *
 * [MF-001] Tests that banner is independently testable
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// ApiError is kept real: the banner branches on `instanceof ApiError`.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  appApi: {
    startUpdate: vi.fn(),
    ping: vi.fn(),
    checkForUpdate: vi.fn(),
  },
}));

import {
  UpdateNotificationBanner,
  type UpdateNotificationBannerProps,
} from '@/components/worktree/UpdateNotificationBanner';
import { ApiError, appApi } from '@/lib/api-client';

describe('UpdateNotificationBanner', () => {
  const defaultProps: UpdateNotificationBannerProps = {
    hasUpdate: true,
    latestVersion: '0.3.0',
    releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
    updateCommand: 'npm install -g commandmate@latest',
    installType: 'global',
  };

  it('should render when hasUpdate is true', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    const banner = screen.getByTestId('update-notification-banner');
    expect(banner).toBeDefined();
  });

  it('should not render when hasUpdate is false', () => {
    render(<UpdateNotificationBanner {...defaultProps} hasUpdate={false} />);

    const banner = screen.queryByTestId('update-notification-banner');
    expect(banner).toBeNull();
  });

  it('should display "available" i18n text', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    // The mock useTranslations returns the full key path
    expect(screen.getByText('worktree.update.available')).toBeDefined();
  });

  it('should display latest version with i18n', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    // Mock translates "update.latestVersion" with {version: "0.3.0"} param
    expect(screen.getByText('worktree.update.latestVersion')).toBeDefined();
  });

  it('should display update command for global install', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    expect(screen.getByText('npm install -g commandmate@latest')).toBeDefined();
  });

  it('should not display update command for local install', () => {
    render(
      <UpdateNotificationBanner
        {...defaultProps}
        installType="local"
        updateCommand={null}
      />
    );

    expect(screen.queryByText('npm install -g commandmate@latest')).toBeNull();
  });

  it('should render release link with correct attributes', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    const link = screen.getByText('worktree.update.viewRelease');
    expect(link).toBeDefined();
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('should not render release link when releaseUrl is null', () => {
    render(<UpdateNotificationBanner {...defaultProps} releaseUrl={null} />);

    expect(screen.queryByText('worktree.update.viewRelease')).toBeNull();
  });

  it('should display data preservation message', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    expect(screen.getByText('worktree.update.dataPreserved')).toBeDefined();
  });

  it('should not display latest version when null', () => {
    render(<UpdateNotificationBanner {...defaultProps} latestVersion={null} />);

    // Should not find the version line since latestVersion is null
    expect(screen.queryByText(/worktree\.update\.latestVersion/)).toBeNull();
  });

  // =========================================================================
  // Accessibility tests (WCAG 4.1.3)
  // =========================================================================
  describe('accessibility', () => {
    it('should have role="status" for screen reader announcement', () => {
      render(<UpdateNotificationBanner {...defaultProps} />);

      const banner = screen.getByTestId('update-notification-banner');
      expect(banner.getAttribute('role')).toBe('status');
    });

    it('should have aria-label for screen readers', () => {
      render(<UpdateNotificationBanner {...defaultProps} />);

      const banner = screen.getByTestId('update-notification-banner');
      expect(banner.getAttribute('aria-label')).toBeDefined();
      expect(banner.getAttribute('aria-label')).not.toBe('');
    });

    it('should have aria-hidden on decorative arrow icon', () => {
      render(<UpdateNotificationBanner {...defaultProps} />);

      const arrow = screen.getByText('\u2192');
      expect(arrow.getAttribute('aria-hidden')).toBe('true');
    });
  });

  // =========================================================================
  // Edge case: unknown install type
  // =========================================================================
  it('should not display update command for unknown install type', () => {
    render(
      <UpdateNotificationBanner
        {...defaultProps}
        installType="unknown"
        updateCommand={null}
      />
    );

    expect(screen.queryByText('npm install -g commandmate@latest')).toBeNull();
  });

  // =========================================================================
  // Issue #1395: npx updates in place now (button + restart notice)
  // =========================================================================
  describe('npx relaunch (Issue #1395)', () => {
    const npxProps: UpdateNotificationBannerProps = {
      ...defaultProps,
      installType: 'npx',
      updateCommand: null,
    };

    it('shows the update button for an npx install (in-place update is supported now)', () => {
      render(<UpdateNotificationBanner {...npxProps} />);

      expect(screen.getByTestId('update-now-button')).toBeDefined();
    });

    it('shows the npx restart notice (port/flags may change) alongside the button', () => {
      render(<UpdateNotificationBanner {...npxProps} />);

      expect(screen.getByTestId('update-npx-notice')).toBeDefined();
      expect(screen.getByText('worktree.update.npxRestartNotice')).toBeDefined();
    });

    it.each(['global', 'local', 'unknown'] as const)(
      'does not show the npx restart notice for a %s install',
      (installType) => {
        render(
          <UpdateNotificationBanner
            {...defaultProps}
            installType={installType}
            updateCommand={null}
          />
        );

        expect(screen.queryByTestId('update-npx-notice')).toBeNull();
      }
    );
  });

  // =========================================================================
  // Issue #1198: one-click self-update
  // =========================================================================
  describe('update button (Issue #1198)', () => {
    const reload = vi.fn();

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(appApi.ping).mockResolvedValue(true);
      vi.mocked(appApi.startUpdate).mockResolvedValue({
        status: 'started',
        willRestart: true,
        logPath: '/home/tester/.commandmate/update.log',
      });
      // jsdom throws "Not implemented: navigation" on the real reload.
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      });
    });

    afterEach(() => {
      cleanup();
      vi.useRealTimers();
    });

    /** Click "Update now" and confirm the dialog. */
    function startUpdate(props: Partial<UpdateNotificationBannerProps> = {}) {
      render(<UpdateNotificationBanner {...defaultProps} {...props} />);
      fireEvent.click(screen.getByTestId('update-now-button'));
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    }

    // --- visibility -------------------------------------------------------
    it('renders the button for a global install', () => {
      render(<UpdateNotificationBanner {...defaultProps} />);
      expect(screen.getByTestId('update-now-button')).toBeDefined();
    });

    it('renders the button for an npx install (Issue #1395)', () => {
      render(
        <UpdateNotificationBanner {...defaultProps} installType="npx" updateCommand={null} />
      );
      expect(screen.getByTestId('update-now-button')).toBeDefined();
    });

    it.each(['local', 'unknown'] as const)(
      'never renders the button for a %s install',
      (installType) => {
        render(
          <UpdateNotificationBanner
            {...defaultProps}
            installType={installType}
            updateCommand={null}
          />
        );
        expect(screen.queryByTestId('update-now-button')).toBeNull();
      }
    );

    // --- idle -> confirming ----------------------------------------------
    it('opens a confirmation dialog rather than updating straight away', () => {
      render(<UpdateNotificationBanner {...defaultProps} />);

      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
      fireEvent.click(screen.getByTestId('update-now-button'));

      expect(screen.getByTestId('confirm-dialog')).toBeDefined();
      expect(appApi.startUpdate).not.toHaveBeenCalled();
    });

    it('cancelling returns to idle without starting an update', async () => {
      render(<UpdateNotificationBanner {...defaultProps} />);

      fireEvent.click(screen.getByTestId('update-now-button'));
      fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

      expect(appApi.startUpdate).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId('update-now-button')).toBeDefined());
    });

    // --- confirming -> updating ------------------------------------------
    it('posts with no body, so the request cannot influence the command', async () => {
      startUpdate();

      await waitFor(() => expect(appApi.startUpdate).toHaveBeenCalledTimes(1));
      expect(vi.mocked(appApi.startUpdate).mock.calls[0]).toEqual([]);
    });

    it('shows the updating state and hides the button once confirmed', async () => {
      startUpdate();

      // `update-progress` also renders for `starting`, so it appears before
      // startUpdate() resolves. Wait for the `updating` copy itself.
      await waitFor(() => expect(screen.getByText('worktree.update.updating')).toBeDefined());
      expect(screen.queryByTestId('update-now-button')).toBeNull();
    });

    // --- updating -> reload ----------------------------------------------
    it('reloads once the server has gone down and come back', async () => {
      vi.mocked(appApi.ping)
        .mockResolvedValueOnce(false) // stopped for the update
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true); // back on the new version

      startUpdate();
      // Polling only starts in `updating`; `update-progress` shows up earlier.
      await waitFor(() => expect(screen.getByText('worktree.update.updating')).toBeDefined());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    }, 15_000);

    /**
     * The server answers throughout only when the update has not taken it down
     * yet. Reloading here would just re-render the old version and dismiss the
     * banner while the update is still running.
     */
    it('does not reload while the server has never gone down', async () => {
      vi.mocked(appApi.ping).mockResolvedValue(true);

      startUpdate();
      // Polling only starts in `updating`; `update-progress` shows up earlier.
      await waitFor(() => expect(screen.getByText('worktree.update.updating')).toBeDefined());
      await waitFor(() => expect(appApi.ping).toHaveBeenCalled(), { timeout: 10_000 });

      expect(reload).not.toHaveBeenCalled();
    }, 15_000);

    // --- confirming -> no-restart (決定3) ---------------------------------
    /**
     * The Issue's headline pitfall: with no PID file the update never stops the
     * server, so waiting for a restart would hang until the 5-minute timeout.
     */
    it('shows manual-restart guidance and never polls when willRestart is false', async () => {
      vi.mocked(appApi.startUpdate).mockResolvedValue({
        status: 'started',
        willRestart: false,
        logPath: '/home/tester/.commandmate/update.log',
      });

      startUpdate();

      await waitFor(() => expect(screen.getByTestId('update-no-restart')).toBeDefined());
      expect(screen.getByText('worktree.update.noRestartDescription')).toBeDefined();
      expect(screen.queryByTestId('update-progress')).toBeNull();
      expect(appApi.ping).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    });

    it('surfaces the log path on the no-restart path', async () => {
      vi.mocked(appApi.startUpdate).mockResolvedValue({
        status: 'started',
        willRestart: false,
        logPath: '/home/tester/.commandmate/update.log',
      });

      startUpdate();

      await waitFor(() => expect(screen.getByTestId('update-log-hint')).toBeDefined());
    });

    // --- updating -> timeout ---------------------------------------------
    it('falls back to manual instructions when the server never returns', async () => {
      vi.mocked(appApi.ping).mockResolvedValue(false);
      vi.useFakeTimers({ shouldAdvanceTime: true });

      startUpdate();
      // The timeout watcher only starts once `state === 'updating'`, so the
      // clock must not be advanced while the banner still says `starting`.
      await waitFor(() => expect(screen.getByText('worktree.update.updating')).toBeDefined());

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

      await waitFor(() => expect(screen.getByTestId('update-timeout')).toBeDefined());
      expect(screen.getByText('commandmate update')).toBeDefined();
      expect(reload).not.toHaveBeenCalled();
    });

    // --- confirming -> error ---------------------------------------------
    it.each([
      [400, 'worktree.update.errorNotGlobal'],
      [409, 'worktree.update.errorInProgress'],
      [500, 'worktree.update.errorGeneric'],
    ])('maps a %i response to its own message', async (status, expectedKey) => {
      vi.mocked(appApi.startUpdate).mockRejectedValue(new ApiError('failed', status));

      startUpdate();

      await waitFor(() => expect(screen.getByTestId('update-error')).toBeDefined());
      expect(screen.getByText(expectedKey)).toBeDefined();
      expect(screen.getByText('commandmate update')).toBeDefined();
    });

    it('reports a generic error when the request never reaches the server', async () => {
      vi.mocked(appApi.startUpdate).mockRejectedValue(new TypeError('Failed to fetch'));

      startUpdate();

      await waitFor(() => expect(screen.getByTestId('update-error')).toBeDefined());
      expect(screen.getByText('worktree.update.errorGeneric')).toBeDefined();
    });

    it('never leaves the update running after an error', async () => {
      vi.mocked(appApi.startUpdate).mockRejectedValue(new ApiError('failed', 409));

      startUpdate();

      await waitFor(() => expect(screen.getByTestId('update-error')).toBeDefined());
      expect(screen.queryByTestId('update-progress')).toBeNull();
      expect(appApi.ping).not.toHaveBeenCalled();
    });

    // --- Issue #1395: npx-specific manual command on timeout/error --------
    /**
     * §4.3: the fixed `commandmate update` is a no-op under npx, so the manual
     * fallback for an npx server must show `npx commandmate@latest` instead.
     */
    it('shows the npx relaunch command (not commandmate update) on timeout for npx', async () => {
      vi.mocked(appApi.ping).mockResolvedValue(false);
      vi.useFakeTimers({ shouldAdvanceTime: true });

      startUpdate({ installType: 'npx', updateCommand: null });
      await waitFor(() => expect(screen.getByText('worktree.update.updating')).toBeDefined());

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);

      await waitFor(() => expect(screen.getByTestId('update-timeout')).toBeDefined());
      expect(screen.getByText('npx commandmate@latest')).toBeDefined();
      expect(screen.queryByText('commandmate update')).toBeNull();
    });

    it('shows the npx relaunch command on error for npx', async () => {
      vi.mocked(appApi.startUpdate).mockRejectedValue(new ApiError('failed', 500));

      startUpdate({ installType: 'npx', updateCommand: null });

      await waitFor(() => expect(screen.getByTestId('update-error')).toBeDefined());
      expect(screen.getByText('npx commandmate@latest')).toBeDefined();
      expect(screen.queryByText('commandmate update')).toBeNull();
    });
  });
});
