/**
 * UpdateNotificationBanner Component
 * Issue #257: Version update notification feature
 *
 * [MF-001] Separated from WorktreeDetailRefactored.tsx to maintain SRP.
 * Displays update notification when a newer version is available.
 * Self-contained and independently testable.
 *
 * @module components/worktree/UpdateNotificationBanner
 */

'use client';

import { useTranslations } from 'next-intl';

/** Props for UpdateNotificationBanner */
export interface UpdateNotificationBannerProps {
  hasUpdate: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  updateCommand: string | null;
  installType: 'global' | 'local' | 'unknown';
}

/**
 * Banner displaying version update notification.
 * Only renders when hasUpdate is true.
 *
 * Features:
 * - i18n support (worktree.update.* keys)
 * - GitHub Releases link (target="_blank", rel="noopener noreferrer")
 * - Install-type-specific update command display
 * - Database preservation notice
 */
export function UpdateNotificationBanner({
  hasUpdate,
  latestVersion,
  releaseUrl,
  updateCommand,
  installType,
}: UpdateNotificationBannerProps) {
  const t = useTranslations('worktree');

  if (!hasUpdate) {
    return null;
  }

  return (
    <div
      className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-2"
      data-testid="update-notification-banner"
    >
      <p className="text-sm font-medium text-blue-800 mb-1">
        {t('update.available')}
      </p>

      {latestVersion && (
        <p className="text-sm text-blue-700 mb-2">
          {t('update.latestVersion', { version: latestVersion })}
        </p>
      )}

      {updateCommand && installType === 'global' && (
        <div className="mb-2">
          <p className="text-xs text-blue-600 mb-1">{t('update.updateCommand')}</p>
          <code className="block bg-blue-100 rounded px-2 py-1 text-xs text-blue-900 font-mono">
            {updateCommand}
          </code>
        </div>
      )}

      {releaseUrl && (
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800 underline"
        >
          {t('update.viewRelease')}
          <span className="ml-1" aria-hidden="true">&rarr;</span>
        </a>
      )}

      <p className="text-xs text-blue-500 mt-2">
        {t('update.dataPreserved')}
      </p>
    </div>
  );
}
