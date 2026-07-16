/**
 * UpdateNotificationBanner Component
 * Issue #257: Version update notification feature
 * Issue #1198: one-click self-update button
 *
 * [MF-001] Separated from WorktreeDetailRefactored.tsx to maintain SRP.
 * Displays update notification when a newer version is available.
 * Self-contained and independently testable.
 *
 * @module components/worktree/UpdateNotificationBanner
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, appApi } from '@/lib/api-client';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Spinner } from '@/components/ui/Spinner';

/** Props for UpdateNotificationBanner */
export interface UpdateNotificationBannerProps {
  hasUpdate: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  updateCommand: string | null;
  installType: 'global' | 'local' | 'unknown';
}

/**
 * Banner lifecycle.
 * `no-restart` is a terminal success state, not a failure: the update landed
 * but this server has no PID file, so it keeps running the old version.
 */
type UpdateState =
  | 'idle'
  | 'confirming'
  | 'starting'
  | 'updating'
  | 'no-restart'
  | 'timeout'
  | 'error';

/** How often the liveness probe runs while waiting for the restart */
const POLL_INTERVAL_MS = 2000;

/** Give up waiting for the server to come back after this long */
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

/** Fixed command shown when the user has to finish the update by hand */
const MANUAL_UPDATE_COMMAND = 'commandmate update';

/**
 * Banner displaying version update notification.
 * Only renders when hasUpdate is true.
 *
 * Features:
 * - i18n support (worktree.update.* keys)
 * - GitHub Releases link (target="_blank", rel="noopener noreferrer")
 * - Install-type-specific update command display
 * - One-click self-update (global installs only, Issue #1198)
 * - Database preservation notice
 * - Accessibility: role="status" for screen reader announcement (WCAG 4.1.3)
 */
export function UpdateNotificationBanner({
  hasUpdate,
  latestVersion,
  releaseUrl,
  updateCommand,
  installType,
}: UpdateNotificationBannerProps) {
  const t = useTranslations('worktree');
  const [state, setState] = useState<UpdateState>('idle');
  const [logPath, setLogPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Survives re-renders so a restart that completes between two polls is not
  // missed, and so the effect below can stay keyed on `state` alone.
  const seenDownRef = useRef(false);

  const isGlobal = installType === 'global';

  const handleConfirm = useCallback(async () => {
    setState('starting');
    try {
      const result = await appApi.startUpdate();
      setLogPath(result.logPath);
      // Issue #1198 決定3: with no PID file the update never stops this server,
      // so waiting for it to drop would hang until the timeout.
      setState(result.willRestart ? 'updating' : 'no-restart');
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setErrorMessage(t('update.errorNotGlobal'));
      } else if (error instanceof ApiError && error.status === 409) {
        setErrorMessage(t('update.errorInProgress'));
      } else {
        setErrorMessage(t('update.errorGeneric'));
      }
      setState('error');
    }
  }, [t]);

  /**
   * Watch the server go down and come back, then reload onto the new version.
   *
   * `commandmate update` stops the server before `npm install -g` and only
   * starts it again afterwards (update.ts steps 6-9), so the outage is tens of
   * seconds — far wider than POLL_INTERVAL_MS. Probe failures here are the
   * expected signal and are swallowed by appApi.ping(): the update must not
   * spray connection-error toasts.
   */
  useEffect(() => {
    if (state !== 'updating') return;

    let cancelled = false;
    const startedAt = Date.now();
    seenDownRef.current = false;

    const timer = setInterval(async () => {
      if (cancelled) return;

      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        setState('timeout');
        return;
      }

      const alive = await appApi.ping();
      if (cancelled) return;

      if (!alive) {
        seenDownRef.current = true;
        return;
      }
      if (seenDownRef.current) {
        window.location.reload();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state]);

  if (!hasUpdate) {
    return null;
  }

  const isBusy = state === 'starting' || state === 'updating';

  return (
    <div
      className="bg-accent-50 border border-accent-200 rounded-lg p-3 mt-2"
      role="status"
      aria-label={t('update.available')}
      data-testid="update-notification-banner"
    >
      <p className="text-sm font-medium text-accent-800 mb-1">
        {t('update.available')}
      </p>

      {latestVersion && (
        <p className="text-sm text-accent-700 mb-2">
          {t('update.latestVersion', { version: latestVersion })}
        </p>
      )}

      {isGlobal && state === 'idle' && (
        <Button
          variant="primary"
          size="sm"
          className="mb-2"
          onClick={() => setState('confirming')}
          data-testid="update-now-button"
        >
          {t('update.updateNow')}
        </Button>
      )}

      {isBusy && (
        <div className="mb-2" data-testid="update-progress">
          <p className="flex items-center text-sm text-accent-800">
            <Spinner size="sm" className="mr-2" />
            {state === 'starting' ? t('update.starting') : t('update.updating')}
          </p>
          {state === 'updating' && (
            <p className="text-xs text-accent-600 mt-1">{t('update.updatingHint')}</p>
          )}
        </div>
      )}

      {state === 'no-restart' && (
        <div className="mb-2" data-testid="update-no-restart">
          <p className="text-sm font-medium text-accent-800">{t('update.noRestartTitle')}</p>
          <p className="text-xs text-accent-600 mt-1">{t('update.noRestartDescription')}</p>
        </div>
      )}

      {state === 'timeout' && (
        <div className="mb-2" data-testid="update-timeout">
          <p className="text-sm font-medium text-accent-800">{t('update.timeoutTitle')}</p>
          <p className="text-xs text-accent-600 mt-1">{t('update.timeoutDescription')}</p>
          <code className="block bg-accent-100 rounded px-2 py-1 mt-1 text-xs text-accent-900 font-mono">
            {MANUAL_UPDATE_COMMAND}
          </code>
        </div>
      )}

      {state === 'error' && (
        <div className="mb-2" data-testid="update-error">
          <p className="text-sm font-medium text-accent-800">{t('update.errorTitle')}</p>
          <p className="text-xs text-accent-600 mt-1">{errorMessage}</p>
          <code className="block bg-accent-100 rounded px-2 py-1 mt-1 text-xs text-accent-900 font-mono">
            {MANUAL_UPDATE_COMMAND}
          </code>
        </div>
      )}

      {logPath && (state === 'no-restart' || state === 'timeout') && (
        <p className="text-xs text-accent-500 mb-2" data-testid="update-log-hint">
          {t('update.logHint', { path: logPath })}
        </p>
      )}

      {updateCommand && isGlobal && state === 'idle' && (
        <div className="mb-2">
          <p className="text-xs text-accent-600 mb-1">{t('update.updateCommand')}</p>
          <code className="block bg-accent-100 rounded px-2 py-1 text-xs text-accent-900 font-mono">
            {updateCommand}
          </code>
        </div>
      )}

      {releaseUrl && (
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-sm text-accent-600 hover:text-accent-800 underline"
        >
          {t('update.viewRelease')}
          <span className="ml-1" aria-hidden="true">&rarr;</span>
        </a>
      )}

      <p className="text-xs text-accent-500 mt-2">
        {t('update.dataPreserved')}
      </p>

      <ConfirmDialog
        isOpen={state === 'confirming'}
        title={t('update.confirmTitle')}
        description={t('update.confirmDescription', { version: latestVersion ?? '' })}
        confirmLabel={t('update.confirmButton')}
        onConfirm={handleConfirm}
        onCancel={() => setState('idle')}
      />
    </div>
  );
}
