/**
 * GitBranchPanel (Issue #781, extracted in #922)
 *
 * Provides local/remote tabs, a create modal, and a per-branch delete confirm
 * modal. Issue #815 demoted this under the collapsed "Advanced operations" group
 * and moved checkout to the core BranchCheckoutDropdown, so this panel renders
 * create/delete only. On mobile the whole panel default-collapses. `isMobile`
 * and the "Ask AI" handler are read from GitPaneContext.
 */

'use client';

import { memo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { BranchInfo, BranchInclude } from '@/types/git';
import { branchCreatePrompt, branchDeletePrompt } from '@/lib/git-ai-prompt-templates';
import { AskAiButton, RefreshIcon } from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';
import { Checkbox, Spinner } from '@/components/ui';

/** Dictionary keys for the local / remote / all include filter tabs. */
const BRANCH_FILTER_KEYS: Record<BranchInclude, string> = {
  local: 'git.branches.filterLocal',
  remote: 'git.branches.filterRemote',
  all: 'git.branches.filterAll',
};

export interface GitBranchPanelProps {
  branches: BranchInfo[];
  include: BranchInclude;
  loading: boolean;
  error: string | null;
  busy: boolean;
  /** Inline error from a checkout/create/delete mutation (shared state). */
  actionError: string | null;
  onIncludeChange: (include: BranchInclude) => void;
  onRefresh: () => void;
  onCreate: (name: string, from: string | undefined) => void;
  onDelete: (name: string, force: boolean) => void;
}

export const GitBranchPanel = memo(function GitBranchPanel({
  branches,
  include,
  loading,
  error,
  busy,
  actionError,
  onIncludeChange,
  onRefresh,
  onCreate,
  onDelete,
}: GitBranchPanelProps) {
  const { isMobile, onInsertToMessage: onAskAi } = useGitPaneContext();
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');
  // Mobile default-collapses the entire section (#780 same approach).
  const [open, setOpen] = useState(!isMobile);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFrom, setCreateFrom] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BranchInfo | null>(null);
  const [deleteForce, setDeleteForce] = useState(false);

  const confirmCreate = useCallback(() => {
    if (createName.trim().length === 0) return;
    onCreate(createName.trim(), createFrom.trim() || undefined);
    setShowCreate(false);
    setCreateName('');
    setCreateFrom('');
  }, [createName, createFrom, onCreate]);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    onDelete(deleteTarget.name, deleteForce);
    setDeleteTarget(null);
    setDeleteForce(false);
  }, [deleteTarget, deleteForce, onDelete]);

  return (
    <div
      className="flex flex-col border-b border-border"
      data-testid="git-branches-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
          {t('git.branches.title')}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="px-2 py-0.5 text-xs rounded border border-input text-foreground hover:bg-muted"
            data-testid="git-branch-create-open"
          >
            {t('git.branches.newButton')}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="p-1 text-muted-foreground hover:text-foreground rounded"
            aria-label={t('git.branches.refresh')}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Local / remote tabs */}
          <div className="flex items-center gap-1 px-3 pb-2">
            {(['local', 'remote', 'all'] as BranchInclude[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => onIncludeChange(tab)}
                className={`px-2 py-0.5 text-xs rounded ${
                  include === tab
                    ? 'bg-accent-100 text-accent-800 dark:bg-accent-900/40 dark:text-accent-200'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
                data-testid={`git-branches-tab-${tab}`}
              >
                {t(BRANCH_FILTER_KEYS[tab])}
              </button>
            ))}
          </div>

          {loading && branches.length === 0 && (
            <div className="flex items-center gap-2 px-3 pb-2" role="status">
              <Spinner size="sm" variant="accent" />
              <span className="sr-only">{t('git.branches.loading')}</span>
            </div>
          )}

          {error && (
            <div
              className="px-3 pb-2 text-xs text-danger-foreground"
              role="alert"
              data-testid="git-branches-error"
            >
              {error}
            </div>
          )}

          {actionError && (
            <div
              className="px-3 pb-2 text-xs text-danger-foreground"
              role="alert"
              data-testid="git-branches-action-error"
            >
              {actionError}
            </div>
          )}

          {!loading && !error && branches.length === 0 && (
            <div className="px-3 pb-2 text-xs text-muted-foreground">{t('git.branches.empty')}</div>
          )}

          {branches.length > 0 && (
            <ul className="divide-y divide-border max-h-64 overflow-y-auto">
              {branches.map((branch) => {
                const deleteDisabled = busy || branch.isCurrent || branch.isDefault;
                return (
                  <li
                    key={`${branch.isRemote ? 'r' : 'l'}:${branch.name}`}
                    className="flex items-center gap-2 px-3 py-1.5"
                    data-testid="git-branch-row"
                  >
                    <span
                      className="flex-1 truncate font-mono text-xs text-foreground"
                      title={branch.name}
                    >
                      {branch.isCurrent && <span className="text-accent-600 dark:text-accent-400 mr-1">●</span>}
                      {branch.name}
                      {branch.isDefault && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {t('git.branches.defaultBadge')}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteForce(false);
                        setDeleteTarget(branch);
                      }}
                      disabled={deleteDisabled}
                      className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-input text-danger-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={t('git.branches.deleteBranch', { name: branch.name })}
                    >
                      {t('git.branches.delete')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/* Create-branch modal */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="branch-create-modal"
        >
          <div className="w-full max-w-md rounded-lg bg-surface p-4 shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">{t('git.branches.createTitle')}</h3>
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t('git.branches.namePlaceholder')}
              className="w-full rounded border border-input bg-surface dark:bg-surface-2 px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="branch-create-name-input"
              aria-label={t('git.branches.nameLabel')}
            />
            <select
              value={createFrom}
              onChange={(e) => setCreateFrom(e.target.value)}
              className="w-full rounded border border-input bg-surface dark:bg-surface-2 px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="branch-create-from-select"
              aria-label={t('git.branches.baseLabel')}
            >
              <option value="">{t('git.branches.currentHead')}</option>
              {branches.map((b) => (
                <option key={`from:${b.isRemote ? 'r' : 'l'}:${b.name}`} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-2">
              {onAskAi && (
                <AskAiButton
                  className="mr-auto"
                  testId="branch-create-ask-ai"
                  disabled={createName.trim().length === 0}
                  onClick={() => {
                    onAskAi(branchCreatePrompt(createName, createFrom));
                    setShowCreate(false);
                  }}
                />
              )}
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="px-3 py-1 text-xs rounded border border-input text-foreground hover:bg-muted"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                onClick={confirmCreate}
                disabled={busy || createName.trim().length === 0}
                className="px-3 py-1 text-xs font-medium rounded bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="branch-create-submit"
              >
                {t('git.branches.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="branch-delete-confirm"
        >
          <div className="w-full max-w-md rounded-lg bg-surface p-4 shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">
              {t('git.branches.deleteTitlePrefix')}
              <span className="font-mono">{deleteTarget.name}</span>
              {t('git.branches.deleteTitleSuffix')}
            </h3>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={deleteForce}
                onCheckedChange={(checked) => setDeleteForce(checked === true)}
                data-testid="branch-delete-force"
              />
              {t('git.branches.forceDeleteLabel')}
            </label>
            <div className="flex items-center justify-end gap-2">
              {onAskAi && deleteTarget && (
                <AskAiButton
                  className="mr-auto"
                  testId="branch-delete-ask-ai"
                  onClick={() => {
                    onAskAi(branchDeletePrompt(deleteTarget.name, deleteForce));
                    setDeleteTarget(null);
                    setDeleteForce(false);
                  }}
                />
              )}
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1 text-xs rounded border border-input text-foreground hover:bg-muted"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={busy}
                className="px-3 py-1 text-xs font-medium rounded bg-danger text-white hover:bg-danger/90 disabled:opacity-50"
                data-testid="branch-delete-confirm-button"
              >
                {t('git.branches.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default GitBranchPanel;
