/**
 * Unit tests for AppUpdateContext (Issue #2654).
 *
 * The provider owns what UpdateNotificationBanner used to own: the update
 * check, the self-update state machine and the restart watch. The headline
 * case is the bug this Issue fixes — the watch must survive the unmount of
 * whatever started it (InfoModal blanks its children when closed), so there
 * is a negative control that puts the provider *inside* the consumer and
 * proves the reload never happens there.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

// ApiError is kept real: the provider branches on `instanceof ApiError`.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  appApi: {
    startUpdate: vi.fn(),
    ping: vi.fn(),
    checkForUpdate: vi.fn(),
  },
}));

import {
  APP_UPDATE_DEFAULT_VALUE,
  AppUpdateProvider,
  UPDATE_RECHECK_INTERVAL_MS,
  useAppUpdate,
  type AppUpdateContextValue,
} from '@/contexts/AppUpdateContext';
import { ApiError, appApi, type UpdateCheckResponse } from '@/lib/api-client';

const BASE_INFO: UpdateCheckResponse = {
  status: 'success',
  hasUpdate: true,
  currentVersion: '0.38.1',
  latestVersion: '0.39.0',
  releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.39.0',
  releaseName: 'v0.39.0',
  publishedAt: '2026-09-20T00:00:00Z',
  installType: 'global',
  updateCommand: 'npm install -g commandmate@latest',
};

function info(overrides: Partial<UpdateCheckResponse> = {}): UpdateCheckResponse {
  return { ...BASE_INFO, ...overrides };
}

const reload = vi.fn();

/** Publishes the live context value and drives it from the test. */
let latest: AppUpdateContextValue = APP_UPDATE_DEFAULT_VALUE;

function Consumer({ testId = 'consumer' }: { testId?: string }) {
  const value = useAppUpdate();
  latest = value;
  return (
    <div data-testid={testId}>
      <span data-testid={`${testId}-state`}>{value.state}</span>
      <span data-testid={`${testId}-checking`}>{String(value.checking)}</span>
      <span data-testid={`${testId}-version`}>{value.updateInfo?.latestVersion ?? 'none'}</span>
      <span data-testid={`${testId}-has-update`}>{String(value.hasUpdate)}</span>
      <span data-testid={`${testId}-can-self-update`}>{String(value.canSelfUpdate)}</span>
      <span data-testid={`${testId}-log-path`}>{value.logPath ?? 'none'}</span>
      <span data-testid={`${testId}-error-key`}>{value.errorKey ?? 'none'}</span>
    </div>
  );
}

/** Mount the provider around a Consumer and wait for the first check to settle. */
async function mountProvider(children?: React.ReactNode): Promise<void> {
  render(<AppUpdateProvider>{children ?? <Consumer />}</AppUpdateProvider>);
  await waitFor(() => expect(screen.getByTestId('consumer-checking').textContent).toBe('false'));
}

beforeEach(() => {
  vi.clearAllMocks();
  latest = APP_UPDATE_DEFAULT_VALUE;
  vi.mocked(appApi.checkForUpdate).mockResolvedValue(info());
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

// ===========================================================================
// Without a provider
// ===========================================================================

describe('useAppUpdate outside AppUpdateProvider', () => {
  it('returns the inert default value', () => {
    const { result } = renderHook(() => useAppUpdate());
    expect(result.current).toEqual(APP_UPDATE_DEFAULT_VALUE);
  });

  it('has no-op actions that never touch the API', async () => {
    const { result } = renderHook(() => useAppUpdate());

    expect(() => result.current.openConfirm()).not.toThrow();
    expect(() => result.current.cancel()).not.toThrow();
    await expect(result.current.confirm()).resolves.toBeUndefined();

    expect(appApi.checkForUpdate).not.toHaveBeenCalled();
    expect(appApi.startUpdate).not.toHaveBeenCalled();
    expect(appApi.ping).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The update check
// ===========================================================================

describe('AppUpdateProvider update check', () => {
  it('checks once on mount and publishes the answer', async () => {
    render(<AppUpdateProvider><Consumer /></AppUpdateProvider>);
    expect(screen.getByTestId('consumer-checking').textContent).toBe('true');

    await waitFor(() => expect(screen.getByTestId('consumer-checking').textContent).toBe('false'));
    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('consumer-version').textContent).toBe('0.39.0');
    expect(screen.getByTestId('consumer-has-update').textContent).toBe('true');
  });

  it.each([
    ['global', 'true'],
    ['npx', 'true'],
    ['local', 'false'],
    ['unknown', 'false'],
  ] as const)('reports canSelfUpdate=%s for a %s install', async (installType, expected) => {
    vi.mocked(appApi.checkForUpdate).mockResolvedValue(info({ installType }));

    await mountProvider();

    expect(screen.getByTestId('consumer-can-self-update').textContent).toBe(expected);
  });

  it('settles with no result when the first check throws', async () => {
    vi.mocked(appApi.checkForUpdate).mockRejectedValue(new Error('offline'));

    await mountProvider();

    expect(screen.getByTestId('consumer-version').textContent).toBe('none');
    expect(screen.getByTestId('consumer-has-update').textContent).toBe('false');
  });

  it('adopts a degraded first answer (there is nothing better to keep)', async () => {
    vi.mocked(appApi.checkForUpdate).mockResolvedValue(
      info({ status: 'degraded', hasUpdate: false, latestVersion: null, installType: 'unknown' })
    );

    await mountProvider();

    expect(screen.getByTestId('consumer-version').textContent).toBe('none');
    expect(screen.getByTestId('consumer-has-update').textContent).toBe('false');
  });

  it('rechecks every UPDATE_RECHECK_INTERVAL_MS while idle', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(appApi.checkForUpdate)
      .mockResolvedValueOnce(info())
      .mockResolvedValue(info({ latestVersion: '0.40.0' }));

    await mountProvider();
    expect(screen.getByTestId('consumer-version').textContent).toBe('0.39.0');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS + 1);
    });

    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.getByTestId('consumer-version').textContent).toBe('0.40.0')
    );
  });

  it.each([
    ['throws', () => vi.mocked(appApi.checkForUpdate).mockRejectedValue(new Error('offline'))],
    [
      'answers degraded',
      () =>
        vi
          .mocked(appApi.checkForUpdate)
          .mockResolvedValue(info({ status: 'degraded', hasUpdate: false, latestVersion: null })),
    ],
  ])('keeps the known update when the recheck %s', async (_name, degrade) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(appApi.checkForUpdate).mockResolvedValueOnce(info());

    await mountProvider();
    degrade();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS + 1);
    });

    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('consumer-has-update').textContent).toBe('true');
    expect(screen.getByTestId('consumer-version').textContent).toBe('0.39.0');
  });

  it('does not recheck while the user is mid-flow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await mountProvider();
    act(() => latest.openConfirm());
    expect(screen.getByTestId('consumer-state').textContent).toBe('confirming');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_RECHECK_INTERVAL_MS + 1);
    });

    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// idle -> confirming
// ===========================================================================

describe('AppUpdateProvider confirmation dialog', () => {
  it.each([
    ['there is no update', info({ hasUpdate: false })],
    ['the install cannot update itself', info({ installType: 'local' })],
  ])('stays idle and shows no dialog when %s', async (_name, response) => {
    vi.mocked(appApi.checkForUpdate).mockResolvedValue(response);

    await mountProvider();
    act(() => latest.openConfirm());

    expect(screen.getByTestId('consumer-state').textContent).toBe('idle');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('renders exactly one dialog no matter how many consumers read the context', async () => {
    render(
      <AppUpdateProvider>
        <Consumer />
        <Consumer testId="second" />
      </AppUpdateProvider>
    );
    await waitFor(() => expect(screen.getByTestId('consumer-checking').textContent).toBe('false'));

    act(() => latest.openConfirm());

    expect(screen.getAllByTestId('confirm-dialog')).toHaveLength(1);
    expect(screen.getByText('worktree.update.confirmTitle')).toBeDefined();
  });

  it('cancelling returns to idle and starts nothing', async () => {
    await mountProvider();
    act(() => latest.openConfirm());

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));

    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('idle'));
    expect(appApi.startUpdate).not.toHaveBeenCalled();
  });

  it('starts at most one update however fast the confirm button is clicked', async () => {
    await mountProvider();
    act(() => latest.openConfirm());

    const confirmButton = screen.getByTestId('confirm-dialog-confirm');
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(appApi.startUpdate).toHaveBeenCalledTimes(1));
    // Issue #1198: the route runs a fixed command, so the request carries nothing.
    expect(vi.mocked(appApi.startUpdate).mock.calls[0]).toEqual([]);
  });
});

// ===========================================================================
// starting -> no-restart / error
// ===========================================================================

describe('AppUpdateProvider start outcomes', () => {
  /** Walk idle -> confirming -> starting. */
  async function startUpdate(): Promise<void> {
    await mountProvider();
    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
  }

  it('lands on no-restart, keeps the log path and never polls when willRestart is false', async () => {
    vi.mocked(appApi.startUpdate).mockResolvedValue({
      status: 'started',
      willRestart: false,
      logPath: '/home/tester/.commandmate/update.log',
    });

    await startUpdate();

    await waitFor(() =>
      expect(screen.getByTestId('consumer-state').textContent).toBe('no-restart')
    );
    expect(screen.getByTestId('consumer-log-path').textContent).toBe(
      '/home/tester/.commandmate/update.log'
    );
    expect(appApi.ping).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'update.errorNotGlobal'],
    [409, 'update.errorInProgress'],
    [500, 'update.errorGeneric'],
  ])('maps a %i response onto its own message key', async (status, expectedKey) => {
    vi.mocked(appApi.startUpdate).mockRejectedValue(new ApiError('failed', status as number));

    await startUpdate();

    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('error'));
    expect(screen.getByTestId('consumer-error-key').textContent).toBe(expectedKey);
    expect(appApi.ping).not.toHaveBeenCalled();
  });

  it('maps a request that never reached the server onto the generic message', async () => {
    vi.mocked(appApi.startUpdate).mockRejectedValue(new TypeError('Failed to fetch'));

    await startUpdate();

    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('error'));
    expect(screen.getByTestId('consumer-error-key').textContent).toBe('update.errorGeneric');
    expect(appApi.ping).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The restart watch — the bug this Issue fixes
// ===========================================================================

/** A consumer the test can unmount, standing in for InfoModal's contents. */
function Unmountable({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(true);
  return (
    <>
      <button type="button" data-testid="hide" onClick={() => setShow(false)}>
        hide
      </button>
      {show && children}
    </>
  );
}

describe('AppUpdateProvider restart watch', () => {
  /** ping answers down, down, then up — the shape of a real restart. */
  function pingsThroughARestart(): void {
    vi.mocked(appApi.ping)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
  }

  it('reloads after the unmount of whatever started the update', async () => {
    pingsThroughARestart();

    render(
      <AppUpdateProvider>
        <Unmountable>
          <Consumer />
        </Unmountable>
      </AppUpdateProvider>
    );
    await waitFor(() => expect(screen.getByTestId('consumer-checking').textContent).toBe('false'));

    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('updating'));

    // The Info modal closes: the banner that started this is gone.
    fireEvent.click(screen.getByTestId('hide'));
    expect(screen.queryByTestId('consumer')).toBeNull();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  }, 15_000);

  /**
   * Negative control: with the provider *inside* the part that unmounts — the
   * pre-#2654 shape — the same steps never reload. Without this, the test
   * above could pass for reasons having nothing to do with the fix.
   */
  it('never reloads when the provider itself is the thing that unmounts', async () => {
    pingsThroughARestart();

    render(
      <Unmountable>
        <AppUpdateProvider>
          <Consumer />
        </AppUpdateProvider>
      </Unmountable>
    );
    await waitFor(() => expect(screen.getByTestId('consumer-checking').textContent).toBe('false'));

    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('updating'));

    fireEvent.click(screen.getByTestId('hide'));
    expect(screen.queryByTestId('consumer')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(reload).not.toHaveBeenCalled();
  }, 15_000);

  it('does not reload while the server has never gone down', async () => {
    vi.mocked(appApi.ping).mockResolvedValue(true);

    await mountProvider();
    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('updating'));

    await waitFor(() => expect(appApi.ping).toHaveBeenCalled(), { timeout: 10_000 });
    expect(reload).not.toHaveBeenCalled();
  }, 15_000);

  it('gives up after the timeout when the server never returns', async () => {
    vi.mocked(appApi.ping).mockResolvedValue(false);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await mountProvider();
    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('updating'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 2000);
    });

    await waitFor(() => expect(screen.getByTestId('consumer-state').textContent).toBe('timeout'));
    expect(reload).not.toHaveBeenCalled();
  });
});
