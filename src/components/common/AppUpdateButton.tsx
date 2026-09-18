/**
 * AppUpdateButton
 * Issue #2654: the "Update v{version}" button at the top right on PC.
 *
 * Reads AppUpdateContext. Placed in DesktopHeader's controls group and in the
 * global Header. Never rendered on mobile: the phone keeps the update UI in
 * the Info tab.
 *
 * @module components/common/AppUpdateButton
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { UpdateNotificationBanner } from '@/components/worktree/UpdateNotificationBanner';
import { useAppUpdate } from '@/contexts/AppUpdateContext';
import { useIsMobile } from '@/hooks/useIsMobile';

/** Opened when update-check returned no release URL */
export const RELEASES_LATEST_URL = 'https://github.com/Kewton/CommandMate/releases/latest';

/** Same look as <Button variant="primary" size="sm">, for the link form */
const LINK_CLASS_NAME =
  'inline-flex flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium bg-accent-600 dark:bg-accent-500 text-white hover:bg-accent-700 dark:hover:bg-accent-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AppUpdateButton() {
  const t = useTranslations('worktree');
  const isMobile = useIsMobile();
  const { updateInfo, hasUpdate, canSelfUpdate, state, openConfirm } = useAppUpdate();
  const [statusOpen, setStatusOpen] = useState(false);

  const version = updateInfo?.latestVersion ?? null;
  if (isMobile || !version) return null;
  if (state === 'idle' && !hasUpdate) return null;

  const isBusy = state === 'starting' || state === 'updating';
  const isSettled = state === 'no-restart' || state === 'timeout' || state === 'error';
  const label = t('update.buttonLabel', { version });

  // local / unknown installs cannot update themselves: open the release page.
  if (!canSelfUpdate && !isBusy && !isSettled) {
    return (
      <a
        href={updateInfo?.releaseUrl ?? RELEASES_LATEST_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={LINK_CLASS_NAME}
        aria-label={t('update.buttonReleaseAriaLabel', { version })}
        data-testid="app-update-button"
      >
        <CircleArrowUp size={16} aria-hidden="true" />
        <span>{label}</span>
      </a>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="primary"
        size="sm"
        loading={isBusy}
        onClick={isSettled ? () => setStatusOpen(true) : openConfirm}
        className="flex-shrink-0 gap-1.5 whitespace-nowrap"
        aria-label={isBusy ? t('update.buttonUpdating') : t('update.buttonAriaLabel', { version })}
        aria-haspopup="dialog"
        aria-busy={isBusy}
        data-testid="app-update-button"
        data-state={state}
      >
        {!isBusy && <CircleArrowUp size={16} aria-hidden="true" />}
        <span>{isBusy ? t('update.buttonUpdating') : label}</span>
      </Button>
      {isSettled && (
        <Modal
          isOpen={statusOpen}
          onClose={() => setStatusOpen(false)}
          title={t('update.statusDialogTitle')}
          size="sm"
        >
          <UpdateNotificationBanner />
        </Modal>
      )}
    </>
  );
}
