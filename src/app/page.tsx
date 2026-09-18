/**
 * Root route (/) — 開く画面を決めて移動する（Issue #2643）。
 *
 * ダッシュボードは描かない。共有キャッシュ（`useWorktreesCacheContext`、Issue #709）の
 * 読込が終わったら、次の順で 1 つだけ表示する。
 *
 * 1. 初回読込中（一覧がまだ空）: スピナー
 * 2. 取得に失敗し、一覧が空: エラーと再試行ボタン
 * 3. 一覧が空（リポジトリ未登録、または worktree が 0 件）: 初回ガイド（OnboardingChecklist）、
 *    「ブランチがありません」、「リポジトリを追加」リンク。移動しない。`repositories` は worktrees の
 *    集計（`getRepositories`）なので、判定には使わない
 * 4. それ以外: 最後に開いたブランチ（非表示リポジトリのものは除く）へ、無ければ `/sessions` へ
 *    `router.replace`。移動が終わるまではスピナー
 *
 * 行き先の決定は `@/lib/last-opened-worktree`。page ファイルは Next が認める名前しか
 * export できないので、ここには置かない。
 */

'use client';

import { useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/layout';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { OnboardingChecklist } from '@/components/home/OnboardingChecklist';
import { Button, Spinner } from '@/components/ui';
import {
  buildHiddenRepositoryPathSet,
  filterWorktreesByVisibility,
} from '@/lib/sidebar-utils';
import {
  readLastOpenedWorktreeId,
  resolveHomeRedirect,
} from '@/lib/last-opened-worktree';

export default function Home() {
  const t = useTranslations('common');
  const router = useRouter();
  const { worktrees, repositories, isLoading, error, refresh } = useWorktreesCacheContext();

  const isFirstLoad = isLoading && worktrees.length === 0;
  const hasLoadError = !isFirstLoad && error !== null && worktrees.length === 0;
  // `repositories` は worktrees の集計なので、空状態は一覧で判定する（Issue #2643）。
  const isEmpty = !isFirstLoad && !hasLoadError && worktrees.length === 0;
  const shouldRedirect = !isFirstLoad && !hasLoadError && !isEmpty;

  const visibleWorktreeIds = useMemo(
    () =>
      filterWorktreesByVisibility(worktrees, buildHiddenRepositoryPathSet(repositories)).map(
        (wt) => wt.id
      ),
    [worktrees, repositories]
  );

  // ポーリングで一覧が更新されるたびに replace し直さないよう、1 回だけ移動する。
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (!shouldRedirect || redirectedRef.current) return;
    redirectedRef.current = true;
    router.replace(
      resolveHomeRedirect({
        lastOpenedId: readLastOpenedWorktreeId(),
        worktreeIds: visibleWorktreeIds,
      })
    );
  }, [shouldRedirect, visibleWorktreeIds, router]);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        {hasLoadError ? (
          <div data-testid="home-load-error" role="alert" className="py-16 text-center">
            <p className="text-sm text-muted-foreground">{t('sidebar.branchesLoadFailed')}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              data-testid="home-load-retry"
              onClick={() => {
                void refresh();
              }}
            >
              {t('sidebar.retryLoadBranches')}
            </Button>
          </div>
        ) : isEmpty ? (
          <div data-testid="home-empty">
            <OnboardingChecklist
              worktrees={worktrees}
              repositories={repositories}
              isLoading={false}
              error={null}
            />
            <div className="text-center">
              <p className="text-sm text-muted-foreground">{t('sidebar.noBranchesAvailable')}</p>
              <Link
                href="/repositories"
                data-testid="home-add-repository"
                className="mt-3 inline-block rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-accent-500 dark:hover:bg-accent-600"
              >
                {t('repositories.add')}
              </Link>
            </div>
          </div>
        ) : (
          <div
            data-testid="home-loading"
            role="status"
            aria-label={t('loadingPage')}
            className="flex justify-center py-16"
          >
            <Spinner size="lg" variant="muted" />
          </div>
        )}
      </div>
    </AppShell>
  );
}
