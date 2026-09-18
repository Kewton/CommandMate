/**
 * VersionSection Component
 * Issue #257: Version update notification feature
 *
 * [SF-001] Extracted from WorktreeDetailRefactored.tsx to eliminate
 * version display duplication between InfoModal (line 507-511) and
 * MobileInfoContent (line 775-779). Both locations now use this component.
 *
 * [CONS-005] Accepts className prop to absorb style differences between
 * InfoModal (recessed surface) and MobileInfoContent (card + border).
 *
 * @module components/worktree/VersionSection
 */

'use client';

import { useTranslations } from 'next-intl';
import { useAppUpdate } from '@/contexts/AppUpdateContext';
import { UpdateNotificationBanner } from './UpdateNotificationBanner';

/**
 * Props for VersionSection.
 * [CONS-005] className allows parent to specify container styling.
 */
export interface VersionSectionProps {
  version: string;
  className?: string;
}

/**
 * Version display section with optional update notification.
 * Reads AppUpdateContext (Issue #2654) for the in-flight check; the banner
 * reads the same context for the update itself.
 *
 * Used in both InfoModal and MobileInfoContent for DRY compliance.
 */
export function VersionSection({ version, className }: VersionSectionProps) {
  const t = useTranslations('worktree');
  const { checking } = useAppUpdate();

  return (
    <div className={className} data-testid="version-section">
      <h2 className="text-sm font-medium text-muted-foreground mb-1">
        {t('update.version')}
      </h2>
      <p className="text-sm text-foreground">{version}</p>

      {checking && (
        <p className="text-xs text-muted-foreground mt-1" data-testid="version-loading">
          ...
        </p>
      )}

      <UpdateNotificationBanner />
    </div>
  );
}
