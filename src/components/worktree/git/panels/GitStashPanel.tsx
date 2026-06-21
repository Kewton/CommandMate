/**
 * GitStashPanel (Issue #782, extracted in #922)
 *
 * Lists stashes and exposes push / pop / apply / drop. Self-fetched on mount +
 * after a mutation only (NO 5s poll, S3-004). Mobile-collapsed by default like
 * the Changes / Branches panels. `isMobile` and the "Ask AI" handler are read
 * from GitPaneContext.
 */

'use client';

import { memo, useState } from 'react';
import type { StashInfo } from '@/types/git';
import { stashCleanupPrompt, stashConflictPrompt } from '@/lib/git-ai-prompt-templates';
import { DANGER_ZONE_RUNNING_SESSION_WARNING } from '@/config/git-status-config';
import { AskAiButton, RefreshIcon } from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';

export interface GitStashPanelProps {
  stashes: StashInfo[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  conflictNotice: string | null;
  hasRunningSession: boolean;
  onRefresh: () => void;
  onPush: (message: string, includeUntracked: boolean) => void;
  onPop: (index: number) => void;
  onApply: (index: number) => void;
  onDrop: (index: number) => void;
}

export const GitStashPanel = memo(function GitStashPanel({
  stashes,
  loading,
  error,
  busy,
  actionError,
  conflictNotice,
  hasRunningSession,
  onRefresh,
  onPush,
  onPop,
  onApply,
  onDrop,
}: GitStashPanelProps) {
  const { isMobile, onInsertToMessage: onAskAi } = useGitPaneContext();
  const [open, setOpen] = useState(!isMobile);
  const [pushMessage, setPushMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [dropConfirm, setDropConfirm] = useState<number | null>(null);

  return (
    <div
      className="border-b border-gray-200 dark:border-gray-700"
      data-testid="git-stash-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
          Stash {stashes.length > 0 && <span className="text-xs text-gray-400">({stashes.length})</span>}
        </button>
        <div className="flex items-center gap-1">
          {open && onAskAi && stashes.length > 0 && (
            <AskAiButton
              testId="stash-cleanup-ask-ai"
              onClick={() => onAskAi(stashCleanupPrompt(stashes))}
            />
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
            aria-label="Refresh stash list"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="git-stash-error">
              {error}
            </div>
          )}
          {actionError && (
            <div className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="git-stash-action-error">
              {actionError}
            </div>
          )}
          {conflictNotice && (
            <div className="flex items-start justify-between gap-2">
              <div className="text-xs text-orange-600 dark:text-orange-400" role="status" data-testid="git-stash-conflict">
                {conflictNotice}
              </div>
              {onAskAi && (
                <AskAiButton
                  className="shrink-0"
                  testId="stash-conflict-ask-ai"
                  onClick={() => onAskAi(stashConflictPrompt(conflictNotice))}
                />
              )}
            </div>
          )}

          {/* Push form */}
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              value={pushMessage}
              onChange={(e) => setPushMessage(e.target.value)}
              placeholder="Stash message (optional)"
              className="w-full px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              data-testid="git-stash-push-message"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={includeUntracked}
                  onChange={(e) => setIncludeUntracked(e.target.checked)}
                  data-testid="git-stash-include-untracked"
                />
                Include untracked
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onPush(pushMessage, includeUntracked);
                  setPushMessage('');
                  setIncludeUntracked(false);
                }}
                className="px-2 py-1 text-xs rounded bg-cyan-600 hover:bg-cyan-700 text-white disabled:opacity-50"
                data-testid="stash-push-button"
              >
                Stash
              </button>
            </div>
          </div>

          {/* Stash list */}
          {loading ? (
            <div className="py-3 text-center text-xs text-gray-500 dark:text-gray-400" role="status">
              Loading stashes...
            </div>
          ) : stashes.length === 0 ? (
            <div className="py-3 text-center text-xs text-gray-500 dark:text-gray-400">No stashes</div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
              {stashes.map((stash) => (
                <li key={stash.index} className="py-1.5" data-testid="git-stash-row">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-xs text-cyan-600 dark:text-cyan-400">
                        stash@{'{'}{stash.index}{'}'}
                      </span>
                      <span className="ml-2 text-xs text-gray-700 dark:text-gray-300 truncate">
                        {stash.message}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onApply(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                        data-testid="stash-apply-button"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onPop(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                        data-testid="stash-pop-button"
                      >
                        Pop
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDropConfirm(stash.index)}
                        className="px-1.5 py-0.5 text-xs rounded border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                        data-testid="stash-drop-button"
                      >
                        Drop
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Drop confirm dialog */}
      {dropConfirm !== null && (
        <div
          className="px-3 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20"
          data-testid="git-stash-drop-confirm"
          role="dialog"
        >
          <p className="text-xs text-red-700 dark:text-red-300">
            stash@{'{'}{dropConfirm}{'}'} を完全に削除します。この操作は取り消せません。
          </p>
          {hasRunningSession && (
            <p
              className="mt-1 text-xs text-red-700 dark:text-red-300"
              data-testid="git-stash-drop-session-warning"
            >
              {DANGER_ZONE_RUNNING_SESSION_WARNING}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onDrop(dropConfirm);
                setDropConfirm(null);
              }}
              className="px-2 py-1 text-xs rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              data-testid="git-stash-drop-confirm-button"
            >
              Drop
            </button>
            <button
              type="button"
              onClick={() => setDropConfirm(null)}
              className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default GitStashPanel;
