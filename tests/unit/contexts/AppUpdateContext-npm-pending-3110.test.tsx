/**
 * AppUpdateContext while a release is not on npm yet (Issue #3110).
 *
 * - `pendingVersion` is published from the update check and blocks the update.
 * - A `not_yet_published` refusal is announced at once (no 5-minute restart
 *   wait) and the state returns to idle.
 * - While pending, the check reruns every 5 minutes instead of every hour.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  appApi: {
    startUpdate: vi.fn(),
    ping: vi.fn(),
    checkForUpdate: vi.fn(),
  },
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/common/Toast', () => ({
  useToast: () => ({ showToast }),
}));

import {
  APP_UPDATE_DEFAULT_VALUE,
  AppUpdateProvider,
  UPDATE_PENDING_RECHECK_INTERVAL_MS,
  UPDATE_RECHECK_INTERVAL_MS,
  useAppUpdate,
  type AppUpdateContextValue,
} from '@/contexts/AppUpdateContext';
import { ApiError, appApi } from '@/lib/api-client';
import { makeUpdateInfo } from '@tests/helpers/app-update-context';

const PENDING_INFO = makeUpdateInfo({
  hasUpdate: false,
  latestVersion: '0.44.0',
  updateCommand: null,
  pendingVersion: '0.44.0',
});

let latest: AppUpdateContextValue = APP_UPDATE_DEFAULT_VALUE;

function Consumer() {
  const value = useAppUpdate();
  latest = value;
  return (
    <div>
      <span data-testid="state">{value.state}</span>
      <span data-testid="checking">{String(value.checking)}</span>
      <span data-testid="has-update">{String(value.hasUpdate)}</span>
      <span data-testid="pending">{value.pendingVersion ?? 'none'}</span>
    </div>
  );
}

async function mountProvider(): Promise<void> {
  render(
    <AppUpdateProvider>
      <Consumer />
    </AppUpdateProvider>
  );
  await waitFor(() => expect(screen.getByTestId('checking').textContent).toBe('false'));
}

beforeEach(() => {
  vi.clearAllMocks();
  latest = APP_UPDATE_DEFAULT_VALUE;
  vi.mocked(appApi.checkForUpdate).mockResolvedValue(makeUpdateInfo());
  vi.mocked(appApi.ping).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AppUpdateProvider pendingVersion (Issue #3110)', () => {
  it('publishes pendingVersion and refuses to open the confirmation', async () => {
    vi.mocked(appApi.checkForUpdate).mockResolvedValue(PENDING_INFO);

    await mountProvider();

    expect(screen.getByTestId('pending').textContent).toBe('0.44.0');
    expect(screen.getByTestId('has-update').textContent).toBe('false');
    act(() => latest.openConfirm());
    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('defaults pendingVersion to null (older server responses carry no field)', async () => {
    const legacy = makeUpdateInfo();
    delete (legacy as { pendingVersion?: unknown }).pendingVersion;
    vi.mocked(appApi.checkForUpdate).mockResolvedValue(legacy);

    await mountProvider();

    expect(screen.getByTestId('pending').textContent).toBe('none');
    expect(APP_UPDATE_DEFAULT_VALUE.pendingVersion).toBeNull();
  });

  it('rechecks every UPDATE_PENDING_RECHECK_INTERVAL_MS while pending, then turns the update on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(appApi.checkForUpdate)
      .mockResolvedValueOnce(PENDING_INFO)
      .mockResolvedValue(makeUpdateInfo({ latestVersion: '0.44.0' }));

    await mountProvider();
    expect(UPDATE_PENDING_RECHECK_INTERVAL_MS).toBeLessThan(UPDATE_RECHECK_INTERVAL_MS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_PENDING_RECHECK_INTERVAL_MS + 1);
    });

    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('has-update').textContent).toBe('true'));
    expect(screen.getByTestId('pending').textContent).toBe('none');

    // Published: back to the hourly cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_PENDING_RECHECK_INTERVAL_MS + 1);
    });
    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps the hourly cadence when nothing is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await mountProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_PENDING_RECHECK_INTERVAL_MS + 1);
    });

    expect(appApi.checkForUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('AppUpdateProvider not_yet_published (Issue #3110)', () => {
  async function confirmUpdate(): Promise<void> {
    await mountProvider();
    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
  }

  it('announces the refusal at once and returns to idle without waiting for a restart', async () => {
    vi.mocked(appApi.startUpdate).mockRejectedValue(
      new ApiError('not on npm', 409, { error: 'not on npm', code: 'not_yet_published' })
    );

    await confirmUpdate();

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast).toHaveBeenCalledWith('worktree.update.notYetPublished', 'info');
    expect(screen.getByTestId('state').textContent).toBe('idle');
    expect(appApi.ping).not.toHaveBeenCalled();
    // The check reruns so the pending state can show up.
    await waitFor(() => expect(appApi.checkForUpdate).toHaveBeenCalledTimes(2));
  });

  it('lets the user retry after the refusal', async () => {
    vi.mocked(appApi.startUpdate)
      .mockRejectedValueOnce(
        new ApiError('not on npm', 409, { error: 'not on npm', code: 'not_yet_published' })
      )
      .mockResolvedValue({ status: 'started', willRestart: false, logPath: '/tmp/update.log' });

    await confirmUpdate();
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));

    act(() => latest.openConfirm());
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('no-restart'));
    expect(appApi.startUpdate).toHaveBeenCalledTimes(2);
  });

  it('still maps an in_progress 409 onto the error state', async () => {
    vi.mocked(appApi.startUpdate).mockRejectedValue(
      new ApiError('busy', 409, { error: 'busy', code: 'in_progress' })
    );

    await confirmUpdate();

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    expect(latest.errorKey).toBe('update.errorInProgress');
    expect(showToast).not.toHaveBeenCalled();
  });
});
