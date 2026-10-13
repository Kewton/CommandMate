/**
 * Repositories Page (/repositories)
 *
 * Issue #600: UX refresh - Repository management.
 * Issue #644: Repository list + inline display_name edit.
 *   - refreshKey is incremented when Add/Sync finishes in RepositoryManager
 *     so RepositoryList refetches automatically.
 *   - It is also incremented when a row's display_name is updated so that
 *     other screens reading the same data via worktreeApi can be refreshed
 *     indirectly (via parent refreshKey bump).
 * Issue #880: RepositoryManager (Add Repository / Sync All actions) is placed
 *   ABOVE RepositoryList so the action buttons appear at the top of the page.
 * Issue #3579: the <h1> is the only screen name (the global Header no longer
 *   repeats it), so it uses the sidebar destination's word, `common.nav.*`.
 * Issue #3586: the description is `common.repositories.pageDescription`, not a literal.
 */

'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PullToRefresh } from '@/components/common/PullToRefresh';
import { useIsMobile } from '@/hooks/useIsMobile';
import { RepositoryList, RepositoryManager } from '@/components/repository';

/** Issue #1128: minimum spinner hold so a pull reads as a real refresh. */
const REPOSITORIES_REFRESH_MIN_MS = 500;

export default function RepositoriesPage() {
  const tCommon = useTranslations('common');
  const isMobile = useIsMobile();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Issue #1128: pull-to-refresh bumps refreshKey (which refetches the list) and
  // holds the spinner briefly so the gesture reads as a refresh.
  const handlePullRefresh = useCallback(async () => {
    setRefreshKey((k) => k + 1);
    await new Promise((resolve) => setTimeout(resolve, REPOSITORIES_REFRESH_MIN_MS));
  }, []);

  return (
    <PullToRefresh
      onRefresh={handlePullRefresh}
      enabled={isMobile}
      className="container-custom py-8 h-full"
    >
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground mb-2">{tCommon('nav.repositories')}</h1>
        <p className="text-sm text-muted-foreground">
          {tCommon('repositories.pageDescription')}
        </p>
      </div>

      <div className="space-y-6">
        <RepositoryManager onRepositoryAdded={handleChanged} />
        <RepositoryList refreshKey={refreshKey} onChanged={handleChanged} />
      </div>
    </PullToRefresh>
  );
}
