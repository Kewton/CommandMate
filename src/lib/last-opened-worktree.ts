/**
 * 最後に開いたブランチ（worktree）の記録と、`/` の行き先の決定（Issue #2643）。
 *
 * `/` はダッシュボードを描かず、ここで決めた画面へ `router.replace` する。
 * 記録は端末ごと（localStorage）で、サーバーには送らない。
 *
 * - `readLastOpenedWorktreeId` / `writeLastOpenedWorktreeId` は例外を投げない。
 *   SSR（window なし）・プライベートウィンドウ・ストレージ拒否では「記録なし」として振る舞う。
 * - `resolveHomeRedirect` は純関数。記録した ID が今の一覧に無ければ（削除・非表示・別端末の記録）
 *   `/sessions` を返す。
 */

export const LAST_OPENED_WORKTREE_STORAGE_KEY = 'commandmate.lastOpenedWorktreeId';

/** `/` の行き先。記録が使えないときはセッション画面。 */
export const HOME_FALLBACK_PATH = '/sessions';

export function readLastOpenedWorktreeId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LAST_OPENED_WORKTREE_STORAGE_KEY);
    return value ? value : null;
  } catch {
    return null;
  }
}

export function writeLastOpenedWorktreeId(id: string): void {
  if (typeof window === 'undefined' || !id) return;
  try {
    window.localStorage.setItem(LAST_OPENED_WORKTREE_STORAGE_KEY, id);
  } catch {
    // 保存できない環境では記録しない（`/` はセッション画面へ行く）
  }
}

export function resolveHomeRedirect(input: {
  lastOpenedId: string | null;
  worktreeIds: readonly string[];
}): string {
  const { lastOpenedId, worktreeIds } = input;
  if (lastOpenedId && worktreeIds.includes(lastOpenedId)) {
    return `/worktrees/${encodeURIComponent(lastOpenedId)}`;
  }
  return HOME_FALLBACK_PATH;
}
