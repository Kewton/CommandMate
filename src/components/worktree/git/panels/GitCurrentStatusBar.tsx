/**
 * GitCurrentStatusBar (Issue #779, extracted in #922)
 *
 * Current Status section displayed at the top of GitPane. Shows the current
 * branch chip, an "uncommitted" dirty badge, ahead/behind counts (only when
 * aheadBehind is non-null), a branch-mismatch warning, and a dedicated refresh
 * button. Failures are surfaced inline and never affect the commit history /
 * diff sections below. `isMobile` is read from GitPaneContext.
 *
 * Issue #1515: ahead/behind is a comparison against the LAST FETCHED remote
 * state, which used to be invisible to the reader — so this section now also
 * renders (A-3) how long ago that fetch was, and (B-2) a badge explaining WHY
 * the `↑N ↓N` chip is missing instead of dropping it silently. The refresh
 * button is wired by GitPane to "fetch, then re-read status" (A-1), so it can
 * be in-flight for seconds; `refreshing` drives its disabled/spinner state.
 */

'use client';

import { memo, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AheadBehindReason, GitStatus } from '@/types/models';
import { RefreshIcon } from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';
import { Spinner } from '@/components/ui/Spinner';
import { formatRelativeTime } from '@/lib/date-utils';
import { getDateFnsLocale } from '@/lib/date-locale';

export interface GitCurrentStatusBarProps {
  gitStatus: GitStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  /**
   * Issue #1515 (A-1): "fetch from the remote, then re-read status". No longer a
   * local-only re-read, so it can stay in flight for seconds.
   */
  onRefresh: () => void;
  /**
   * True while a remote operation is in flight (the fetch this button started,
   * or a sibling pull/push holding the remote). Disables the button so the click
   * cannot stack a second network op, and swaps the icon for a spinner.
   */
  refreshing?: boolean;
}

/**
 * i18n key pair per B-1 reason code (Issue #1515, B-2). A lookup table keeps the
 * badge exhaustive over the union — a new reason fails to compile here rather
 * than silently rendering nothing, which is the bug this replaces.
 */
const REASON_KEYS: Record<AheadBehindReason, { badgeKey: string; tooltipKey: string }> = {
  no_upstream: {
    badgeKey: 'git.currentStatus.noUpstreamBadge',
    tooltipKey: 'git.currentStatus.noUpstreamTooltip',
  },
  upstream_gone: {
    badgeKey: 'git.currentStatus.upstreamGoneBadge',
    tooltipKey: 'git.currentStatus.upstreamGoneTooltip',
  },
  detached: {
    badgeKey: 'git.currentStatus.detachedBadge',
    tooltipKey: 'git.currentStatus.detachedTooltip',
  },
  error: {
    badgeKey: 'git.currentStatus.aheadBehindErrorBadge',
    tooltipKey: 'git.currentStatus.aheadBehindErrorTooltip',
  },
};

export const GitCurrentStatusBar = memo(function GitCurrentStatusBar({
  gitStatus,
  statusLoading,
  statusError,
  onRefresh,
  refreshing = false,
}: GitCurrentStatusBarProps) {
  const { isMobile } = useGitPaneContext();
  const t = useTranslations('worktree');
  const locale = useLocale();

  // Issue #1515 (A-3): "Last fetch: 5 minutes ago". Recomputed on every render,
  // which the 5s status poll already triggers (each poll sets a fresh object),
  // so the label stays current without a timer of its own.
  const lastFetchLabel = useMemo(() => {
    const lastFetchAt = gitStatus?.lastFetchAt;
    if (lastFetchAt === undefined || lastFetchAt === null) {
      return t('git.currentStatus.lastFetchNever');
    }
    const relative = formatRelativeTime(
      new Date(lastFetchAt).toISOString(),
      getDateFnsLocale(locale)
    );
    if (!relative) {
      return t('git.currentStatus.lastFetchNever');
    }
    return t('git.currentStatus.lastFetch', { relative });
  }, [gitStatus?.lastFetchAt, locale, t]);

  // Non-null ONLY when the counts are absent (B-1 contract), so the chip and the
  // badge are mutually exclusive by construction.
  const reason: AheadBehindReason | null =
    gitStatus && !gitStatus.aheadBehind ? (gitStatus.aheadBehindReason ?? null) : null;

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-border"
      data-testid="git-status-section"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('git.currentStatus.title')}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="p-1 text-muted-foreground hover:text-foreground rounded disabled:opacity-50"
          aria-label={refreshing ? t('git.currentStatus.refreshing') : t('git.currentStatus.refresh')}
          aria-busy={refreshing}
          data-testid="git-status-refresh-button"
        >
          {refreshing ? <Spinner size="sm" variant="accent" /> : <RefreshIcon />}
        </button>
      </div>

      {/* Loading: only show the spinner before the first successful load */}
      {statusLoading && !gitStatus && (
        <div className="flex items-center gap-2 py-1" role="status">
          <Spinner size="sm" variant="accent" />
          <span className="sr-only">{t('git.currentStatus.loading')}</span>
        </div>
      )}

      {/* Error (does not affect commit history / diff) */}
      {statusError && !gitStatus && (
        <div
          className="text-xs text-danger-foreground"
          role="alert"
          data-testid="git-status-error"
        >
          {statusError}
        </div>
      )}

      {gitStatus && (
        <>
          <div className={`flex items-center flex-wrap ${isMobile ? 'gap-1.5' : 'gap-2'}`}>
            {/* Branch chip */}
            <span
              className="inline-flex items-center max-w-full truncate rounded px-2 py-0.5 text-xs font-mono bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300"
              data-testid="git-status-branch-chip"
              title={gitStatus.currentBranch}
            >
              {gitStatus.currentBranch}
            </span>

            {/* Dirty badge */}
            {gitStatus.isDirty && (
              <span
                className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-warning-subtle text-warning-foreground"
                data-testid="git-status-dirty-badge"
              >
                {t('git.currentStatus.uncommitted')}
              </span>
            )}

            {/* Ahead/behind (only when non-null) */}
            {gitStatus.aheadBehind && (
              <span
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono bg-muted text-foreground"
                data-testid="git-status-ahead-behind"
              >
                <span title={t('git.currentStatus.aheadTooltip')}>↑{gitStatus.aheadBehind.ahead}</span>
                <span title={t('git.currentStatus.behindTooltip')}>↓{gitStatus.aheadBehind.behind}</span>
              </span>
            )}

            {/* Issue #1515 (B-2): why the ahead/behind chip is absent */}
            {reason && (
              <span
                className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground border border-border"
                data-testid="git-status-ahead-behind-reason"
                data-reason={reason}
                title={t(REASON_KEYS[reason].tooltipKey)}
              >
                {t(REASON_KEYS[reason].badgeKey)}
              </span>
            )}
          </div>

          {/* Issue #1515 (A-3): dates the ahead/behind comparison above */}
          <div
            className="text-[11px] text-muted-foreground"
            data-testid="git-status-last-fetch"
            title={t('git.currentStatus.lastFetchTooltip')}
          >
            {lastFetchLabel}
          </div>

          {/* Branch mismatch warning */}
          {gitStatus.isBranchMismatch && (
            <div
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs bg-warning-subtle text-warning-foreground border border-warning-border"
              role="alert"
              data-testid="git-status-mismatch-warning"
            >
              <span aria-hidden="true">⚠</span>
              <span>
                {t('branchMismatch.changedFrom')}{' '}
                <span className="font-medium">{gitStatus.initialBranch}</span>
                {' '}{t('branchMismatch.to')}{' '}
                <span className="font-medium">{gitStatus.currentBranch}</span>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default GitCurrentStatusBar;
