/**
 * UpdateNotificationBanner Component
 * Issue #257: Version update notification feature
 * Issue #1198: one-click self-update button
 * Issue #2654: reads AppUpdateContext; the state machine and the confirm dialog
 * live in AppUpdateProvider
 *
 * [MF-001] Separated from WorktreeDetailRefactored.tsx to maintain SRP.
 * Displays update notification when a newer version is available.
 * Self-contained and independently testable.
 *
 * @module components/worktree/UpdateNotificationBanner
 */

'use client';

import { useTranslations } from 'next-intl';
import { useAppUpdate } from '@/contexts/AppUpdateContext';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

/** Fixed command shown when the user has to finish the update by hand */
const MANUAL_UPDATE_COMMAND = 'commandmate update';

/**
 * Fixed command an npx-launched server is relaunched with. Issue #1395 made the
 * one-click update work for npx, so this is no longer the primary path — it is
 * the manual fallback shown on timeout/error, where `commandmate update` would
 * be a no-op under npx (§4.3).
 */
const NPX_UPDATE_COMMAND = 'npx commandmate@latest';

/**
 * Banner displaying version update notification.
 * Shown while an update is available, and also after one was started
 * (a recheck may no longer report an update once the new version is installed).
 *
 * Features:
 * - i18n support (worktree.update.* keys)
 * - GitHub Releases link (target="_blank", rel="noopener noreferrer")
 * - Install-type-specific update command display
 * - One-click self-update (global / npx installs, Issue #1198 / #1395)
 * - Database preservation notice
 * - Accessibility: role="status" for screen reader announcement (WCAG 4.1.3)
 */
export function UpdateNotificationBanner() {
  const t = useTranslations('worktree');
  const { updateInfo, hasUpdate, canSelfUpdate, state, logPath, errorKey, openConfirm } =
    useAppUpdate();

  // Shown while an update is available, and also after one was started
  // (a recheck may no longer report an update once the new version is installed).
  if (!updateInfo || (!hasUpdate && state === 'idle')) {
    return null;
  }

  const { latestVersion, releaseUrl, updateCommand, installType } = updateInfo;
  const isGlobal = installType === 'global';
  // Issue #1395: an npx server can update in place now — the route relaunches it
  // from a fresh npx cache — so it gets the update button like a global install.
  const isNpx = installType === 'npx';
  // Issue #1395: `commandmate update` is a no-op under npx (§4.3), so the manual
  // fallback shown on timeout/error must be the npx relaunch command instead.
  const manualCommand = isNpx ? NPX_UPDATE_COMMAND : MANUAL_UPDATE_COMMAND;
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

      {canSelfUpdate && state === 'idle' && (
        <Button
          variant="primary"
          size="sm"
          className="mb-2"
          onClick={openConfirm}
          data-testid="update-now-button"
        >
          {t('update.updateNow')}
        </Button>
      )}

      {isNpx && state === 'idle' && (
        <p className="text-xs text-accent-600 mb-2" data-testid="update-npx-notice">
          {t('update.npxRestartNotice')}
        </p>
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
            {manualCommand}
          </code>
        </div>
      )}

      {state === 'error' && (
        <div className="mb-2" data-testid="update-error">
          <p className="text-sm font-medium text-accent-800">{t('update.errorTitle')}</p>
          <p className="text-xs text-accent-600 mt-1">{errorKey ? t(errorKey) : null}</p>
          <code className="block bg-accent-100 rounded px-2 py-1 mt-1 text-xs text-accent-900 font-mono">
            {manualCommand}
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
    </div>
  );
}
