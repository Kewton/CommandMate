/**
 * VersionSection Component
 * Issue #257: Version update notification feature
 *
 * [SF-001] Extracted from WorktreeDetailRefactored.tsx to eliminate
 * version display duplication between InfoModal (line 507-511) and
 * MobileInfoContent (line 775-779). Both locations now use this component.
 *
 * [CONS-005] Accepts className prop to absorb style differences between
 * InfoModal (bg-gray-50) and MobileInfoContent (bg-white border).
 *
 * @module components/worktree/VersionSection
 */

'use client';

import { useTranslations } from 'next-intl';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
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
 * Integrates useUpdateCheck hook and UpdateNotificationBanner.
 *
 * Used in both InfoModal and MobileInfoContent for DRY compliance.
 */
export function VersionSection({ version, className }: VersionSectionProps) {
  const t = useTranslations('worktree');
  const { data, loading } = useUpdateCheck();

  return (
    <div className={className} data-testid="version-section">
      <h2 className="text-sm font-medium text-gray-500 mb-1">
        {t('update.version')}
      </h2>
      <p className="text-sm text-gray-700">{version}</p>

      {loading && (
        <p className="text-xs text-gray-400 mt-1" data-testid="version-loading">
          ...
        </p>
      )}

      {data && data.hasUpdate && (
        <UpdateNotificationBanner
          hasUpdate={data.hasUpdate}
          latestVersion={data.latestVersion}
          releaseUrl={data.releaseUrl}
          updateCommand={data.updateCommand}
          installType={data.installType}
        />
      )}
    </div>
  );
}
